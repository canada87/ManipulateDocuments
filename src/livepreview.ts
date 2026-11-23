// Obsidian-style live preview: markdown syntax is hidden everywhere except on the lines the cursor touches.
import { syntaxTree, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorState, Range, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "md-h md-h1" },
  { tag: t.heading2, class: "md-h md-h2" },
  { tag: t.heading3, class: "md-h md-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "md-h" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], class: "md-link" },
  { tag: t.monospace, class: "md-code" },
  { tag: [t.processingInstruction, t.contentSeparator], class: "md-mark" },
  { tag: t.quote, class: "md-quote" },
  // code inside fenced blocks
  { tag: [t.keyword, t.modifier, t.operatorKeyword], class: "c-kw" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "c-str" },
  { tag: [t.comment, t.meta], class: "c-com" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "c-num" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "c-fn" },
  { tag: [t.typeName, t.className, t.tagName], class: "c-type" },
  { tag: [t.propertyName, t.attributeName], class: "c-prop" },
]);

type Ctx = { baseDir: () => string | null; toSrc: (path: string) => string };

const hide = Decoration.replace({});

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  eq(o: ImageWidget) { return o.src === this.src && o.alt === this.alt; }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "md-img";
    img.alt = this.alt;
    img.src = this.src;
    img.onload = () => view.requestMeasure();
    img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "md-img-broken", textContent: `⚠ ${this.alt || this.src}` }));
    return img;
  }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return Object.assign(document.createElement("span"), { className: "md-bullet", textContent: "◆" }); }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked; }
  toDOM() {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.checked, className: "md-task" });
    return box;
  }
  ignoreEvent() { return false; }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// shortcut: table cells render only **bold**, *italic*, `code`; upgrade to a real inline parser if needed.
const inline = (s: string) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\*([^*]+)\*/g, "<i>$1</i>");

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
}

class TableWidget extends WidgetType {
  constructor(readonly src: string) { super(); }
  eq(o: TableWidget) { return o.src === this.src; }
  toDOM(view: EditorView) {
    const [head, delim, ...body] = this.src.split("\n");
    const align = splitRow(delim ?? "").map(c => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left");
    const cell = (tag: string, c: string, i: number) => `<${tag} style="text-align:${align[i] ?? "left"}">${inline(c)}</${tag}>`;
    const wrap = document.createElement("div");
    wrap.className = "md-table";
    wrap.innerHTML = `<table><thead><tr>${splitRow(head).map((c, i) => cell("th", c, i)).join("")}</tr></thead><tbody>${body.map(r => `<tr>${splitRow(r).map((c, i) => cell("td", c, i)).join("")}</tr>`).join("")}</tbody></table>`;
    // Clicking the rendered table drops the cursor inside it, which switches it back to raw markdown.
    wrap.addEventListener("mousedown", e => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    });
    return wrap;
  }
}

function activeLines(state: EditorState) {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) set.add(l);
  }
  return set;
}

function resolveSrc(raw: string, ctx: Ctx) {
  let src = raw.trim().replace(/^<|>$/g, "");
  if (/^(https?:|data:)/i.test(src)) return src;
  try { src = decodeURI(src); } catch { /* keep raw */ }
  const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(src);
  const base = ctx.baseDir();
  if (!abs && !base) return "";
  return ctx.toSrc(abs ? src : `${base}/${src}`);
}

function lineDecos(state: EditorState, node: SyntaxNode, from: number, to: number, cls: (i: number, first: boolean, last: boolean) => string, out: Range<Decoration>[]) {
  const a = state.doc.lineAt(Math.max(node.from, from)).number;
  const b = state.doc.lineAt(Math.min(node.to, to)).number;
  const first = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number;
  for (let l = a; l <= b; l++) out.push(Decoration.line({ class: cls(l, l === first, l === last) }).range(state.doc.line(l).from));
}

function buildInline(view: EditorView, ctx: Ctx): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const hideMark = (from: number, to: number, eatSpace = false) => {
    if (eatSpace && state.doc.sliceString(to, to + 1) === " ") to++;
    out.push(hide.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: ref => {
        const n = ref.node;
        const name = n.name;
        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) out.push(Decoration.line({ class: `md-line-h${heading[2]}` }).range(state.doc.lineAt(n.from).from));

        switch (name) {
          case "Table": return false; // rendered by tableField
          case "FencedCode":
            lineDecos(state, n, from, to, (_l, f, l) => `md-line-code${f ? " md-line-code-first" : ""}${l ? " md-line-code-last" : ""}`, out);
            return false;
          case "Blockquote":
            lineDecos(state, n, from, to, () => "md-line-quote", out);
            return;
          case "HeaderMark":
            if (!isActive(n.from)) hideMark(n.from, n.to, true);
            return;
          case "QuoteMark":
            if (!isActive(n.from)) hideMark(n.from, n.to, true);
            return;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!isActive(n.from)) hideMark(n.from, n.to);
            return;
          case "CodeMark":
            if (n.parent?.name === "InlineCode" && !isActive(n.from)) hideMark(n.from, n.to);
            return;
          case "HorizontalRule":
            out.push(Decoration.line({ class: "md-line-hr" }).range(state.doc.lineAt(n.from).from));
            if (!isActive(n.from)) hideMark(n.from, n.to);
            return;
          case "Link":
          case "Autolink": {
            if (isActive(n.from)) return;
            const marks = n.getChildren("LinkMark");
            if (name === "Autolink") marks.forEach(m => hideMark(m.from, m.to));
            else if (marks.length >= 2) {
              hideMark(marks[0].from, marks[0].to);
              hideMark(marks[1].from, n.to);
            }
            return;
          }
          case "Image": {
            if (isActive(n.from) || state.doc.lineAt(n.from).number !== state.doc.lineAt(n.to).number) return false;
            const url = n.getChild("URL");
            const marks = n.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "";
            const src = url ? resolveSrc(state.doc.sliceString(url.from, url.to), ctx) : "";
            out.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(n.from, n.to));
            return false;
          }
          case "ListMark": {
            if (isActive(n.from)) return;
            const task = n.nextSibling?.name === "Task";
            if (task) hideMark(n.from, n.to, true);
            else if (n.parent?.parent?.name === "BulletList") out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
            return;
          }
          case "TaskMarker":
            if (!isActive(n.from)) out.push(Decoration.replace({ widget: new CheckboxWidget(/x/i.test(state.doc.sliceString(n.from, n.to))) }).range(n.from, n.to));
            return;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

function buildTables(state: EditorState): DecorationSet {
  const sel = state.selection.ranges;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: ref => {
      const name = ref.name;
      if (name === "Table") {
        const { from, to } = ref;
        const touched = sel.some(r => r.to >= from && r.from <= to);
        // Block widgets must span whole lines (tables nested in quotes/lists stay raw).
        const whole = state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
        if (!touched && whole) out.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to)), block: true }).range(from, to));
        return false;
      }
      // Tables only live in block containers: skip descending into everything else.
      return name === "Document" || name === "Blockquote" || name === "BulletList" || name === "OrderedList" || name === "ListItem";
    },
  });
  return Decoration.set(out);
}

const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update: (deco, tr) => tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? buildTables(tr.state) : deco,
  provide: f => EditorView.decorations.from(f),
});

/** Walk up from a position to the link/url under it and return its target. */
function linkAt(state: EditorState, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "URL") return state.doc.sliceString(n.from, n.to);
    if (n.name === "Link" || n.name === "Autolink" || n.name === "Image") {
      const url = n.getChild("URL");
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

export function livePreview(ctx: Ctx & { openLink: (href: string) => void }) {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildInline(view, ctx); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildInline(u.view, ctx);
      }
    }
  }, { decorations: v => v.decorations });

  const events = EditorView.domEventHandlers({
    mousedown(e, view) {
      const target = e.target as HTMLElement;
      if (target.classList.contains("md-task")) {
        const pos = view.posAtDOM(target);
        const cur = view.state.doc.sliceString(pos, pos + 3);
        view.dispatch({ changes: { from: pos, to: pos + 3, insert: /x/i.test(cur) ? "[ ]" : "[x]" } });
        e.preventDefault();
        return true;
      }
      if (e.ctrlKey || e.metaKey) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const href = pos == null ? null : linkAt(view.state, pos);
        if (href) {
          ctx.openLink(href.replace(/^<|>$/g, ""));
          e.preventDefault();
          return true;
        }
      }
      return false;
    },
  });

  return [plugin, tableField, events];
}
