// Obsidian-style live preview: markdown syntax is hidden everywhere except on the lines the cursor touches.
import { syntaxTree, HighlightStyle } from "@codemirror/language";
import { tags as t, Tag } from "@lezer/highlight";
import { EditorState, Range, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import katex from "katex";
import DOMPurify from "dompurify";

const mathTag = Tag.define(), footnoteTag = Tag.define();

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
  { tag: mathTag, class: "md-math-src" },
  { tag: footnoteTag, class: "md-fn" },
  // code inside fenced blocks
  { tag: [t.keyword, t.modifier, t.operatorKeyword], class: "c-kw" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "c-str" },
  { tag: [t.comment, t.meta], class: "c-com" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "c-num" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "c-fn" },
  { tag: [t.typeName, t.className, t.tagName], class: "c-type" },
  { tag: [t.propertyName, t.attributeName], class: "c-prop" },
]);

// ---------- parser extensions: $math$, [[wikilinks]], [^footnotes] ----------
const DOLLAR = 36, BACKSLASH = 92, OPEN = 91, CARET = 94, NL = 10;
const blank = (c: number) => c === 32 || c === 9 || c === NL || c === -1;
const digit = (c: number) => c >= 48 && c <= 57;

function parseMath(cx: InlineContext, next: number, pos: number) {
  if (next !== DOLLAR) return -1;
  const len = cx.char(pos + 1) === DOLLAR ? 2 : 1;
  if (len === 1 && blank(cx.char(pos + 1))) return -1; // "$ 5" is money, not math
  for (let i = pos + len; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === BACKSLASH) { i++; continue; }
    if (c === NL && len === 1) return -1; // $...$ stays on one line; $$...$$ may span lines
    if (c !== DOLLAR) continue;
    if (len === 2 ? cx.char(i + 1) !== DOLLAR : blank(cx.char(i - 1)) || digit(cx.char(i + 1))) continue;
    if (i === pos + len) return -1;
    return cx.addElement(cx.elt("InlineMath", pos, i + len, [cx.elt("MathMark", pos, pos + len), cx.elt("MathMark", i, i + len)]));
  }
  return -1;
}

function parseWiki(cx: InlineContext, next: number, pos: number) {
  if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
  const m = /^([^[\]\n|]+)(\|[^[\]\n]+)?\]\]/.exec(cx.slice(pos + 2, cx.end));
  if (!m) return -1;
  const end = pos + 2 + m[0].length;
  const marks = [cx.elt("WikiMark", pos, pos + 2)];
  if (m[2]) marks.push(cx.elt("WikiMark", pos + 2, pos + 3 + m[1].length)); // "target|" is hidden when there's an alias
  marks.push(cx.elt("WikiMark", end - 2, end));
  return cx.addElement(cx.elt("WikiLink", pos, end, marks));
}

function parseFootnote(cx: InlineContext, next: number, pos: number) {
  if (next !== OPEN || cx.char(pos + 1) !== CARET) return -1;
  const m = /^[^\]\s]+\]/.exec(cx.slice(pos + 2, cx.end));
  if (!m) return -1;
  const end = pos + 2 + m[0].length;
  return cx.addElement(cx.elt("FootnoteRef", pos, end, [cx.elt("FootnoteMark", pos, pos + 2), cx.elt("FootnoteMark", end - 1, end)]));
}

export const mdExtensions: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: mathTag },
    { name: "MathMark", style: t.processingInstruction },
    { name: "WikiLink", style: t.link },
    { name: "WikiMark", style: t.processingInstruction },
    { name: "FootnoteRef", style: footnoteTag },
    { name: "FootnoteMark", style: t.processingInstruction },
  ],
  parseInline: [
    { name: "InlineMath", parse: parseMath, before: "Emphasis" },
    { name: "WikiLink", parse: parseWiki, before: "Link" },
    { name: "FootnoteRef", parse: parseFootnote, before: "Link" },
  ],
};

/** `[[Note|alias]]` / `[[Note#Heading]]` -> "Note.md" (extension added unless one is given). */
export function wikiHref(inner: string) {
  const target = inner.split("|")[0].split("#")[0].trim();
  return /\.[a-z]{2,8}$/i.test(target) ? target : `${target}.md`;
}

// ---------- widgets ----------
export type Ctx = { baseDir: () => string | null; toSrc: (path: string) => string; openLink: (href: string) => void };

const hide = Decoration.replace({});
// MathML is rendered natively by WebView2/WebKit: no KaTeX fonts or CSS to ship.
export const KATEX = { output: "mathml", throwOnError: false } as const;

/** Rendered blocks: a click puts the cursor inside (back to raw markdown); Ctrl+click follows links. */
function clickToEdit(el: HTMLElement, view: EditorView, ctx: Ctx) {
  el.addEventListener("click", e => e.preventDefault()); // a rendered <a> must never navigate the app itself
  el.addEventListener("mousedown", e => {
    e.preventDefault();
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
    if (href && (e.ctrlKey || e.metaKey)) { ctx.openLink(href); return; }
    view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
    view.focus();
  });
}

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

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly ctx: Ctx) { super(); }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display; }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = this.display ? "md-math md-math-display" : "md-math";
    katex.render(this.tex, el, { ...KATEX, displayMode: this.display });
    clickToEdit(el, view, this.ctx);
    return el;
  }
}

let mermaidLib: Promise<typeof import("mermaid").default> | null = null;
let mermaidSeq = 0;
const svgCache = new Map<string, string>();
/** Mermaid is big: loaded on first use only. */
export async function renderMermaid(code: string) {
  const hit = svgCache.get(code);
  if (hit) return hit;
  const m = await (mermaidLib ??= import("mermaid").then(x => {
    x.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    return x.default;
  }));
  const id = `mmd-${++mermaidSeq}`;
  try {
    const { svg } = await m.render(id, code);
    if (svgCache.size > 50) svgCache.clear();
    svgCache.set(code, svg);
    return svg;
  } finally {
    document.getElementById(`d${id}`)?.remove(); // mermaid leaves its scratch element behind on errors
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly ctx: Ctx) { super(); }
  eq(o: MermaidWidget) { return o.code === this.code; }
  toDOM(view: EditorView) {
    const el = Object.assign(document.createElement("div"), { className: "md-mermaid", textContent: "Rendering diagram…" });
    renderMermaid(this.code)
      .then(svg => { el.innerHTML = svg; })
      .catch(e => { el.textContent = `⚠ Mermaid: ${e instanceof Error ? e.message : e}`; el.classList.add("md-error"); })
      .finally(() => view.requestMeasure());
    clickToEdit(el, view, this.ctx);
    return el;
  }
}

class HtmlWidget extends WidgetType {
  constructor(readonly html: string, readonly ctx: Ctx) { super(); }
  eq(o: HtmlWidget) { return o.html === this.html; }
  toDOM(view: EditorView) {
    const el = Object.assign(document.createElement("div"), { className: "md-html" });
    el.innerHTML = DOMPurify.sanitize(this.html); // the document is untrusted: no scripts or handlers near the Tauri API
    fixImages(el, view, this.ctx);
    clickToEdit(el, view, this.ctx);
    return el;
  }
}

function fixImages(el: HTMLElement, view: EditorView, ctx: Ctx) {
  el.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src");
    if (src) img.src = resolveSrc(src, ctx) || src;
    img.onload = () => view.requestMeasure();
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const INLINE = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)\)|\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\$([^$\s](?:[^$]*[^$\s])?)\$|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*/g;
// shortcut: table cells use a regex renderer (code, images, links, wikilinks, $math$, bold, strike, italic); switch to the lezer tree if cells need more.
export function inline(s: string, ctx: Ctx): string {
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += esc(s.slice(last, m.index));
    last = m.index + m[0].length;
    const [, code, alt, src, wiki, alias, text, href, math, bold, del, ital] = m;
    out += code != null ? `<code>${esc(code)}</code>`
      : src != null ? `<img alt="${esc(alt)}" src="${esc(resolveSrc(src, ctx) || src)}">`
      : wiki != null ? `<a href="${esc(wikiHref(wiki))}">${esc(alias ?? wiki)}</a>`
      : href != null ? `<a href="${esc(href)}">${inline(text, ctx)}</a>`
      : math != null ? katex.renderToString(math, KATEX)
      : bold != null ? `<b>${inline(bold, ctx)}</b>`
      : del != null ? `<s>${inline(del, ctx)}</s>`
      : `<i>${inline(ital, ctx)}</i>`;
  }
  return out + esc(s.slice(last));
}

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
}

class TableWidget extends WidgetType {
  constructor(readonly src: string, readonly ctx: Ctx) { super(); }
  eq(o: TableWidget) { return o.src === this.src; }
  toDOM(view: EditorView) {
    const [head, delim, ...body] = this.src.split("\n");
    const align = splitRow(delim ?? "").map(c => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left");
    const cell = (tag: string, c: string, i: number) => `<${tag} style="text-align:${align[i] ?? "left"}">${inline(c, this.ctx)}</${tag}>`;
    const wrap = document.createElement("div");
    wrap.className = "md-table";
    wrap.innerHTML = `<table><thead><tr>${splitRow(head).map((c, i) => cell("th", c, i)).join("")}</tr></thead><tbody>${body.map(r => `<tr>${splitRow(r).map((c, i) => cell("td", c, i)).join("")}</tr>`).join("")}</tbody></table>`;
    wrap.querySelectorAll("img").forEach(img => { img.onload = () => view.requestMeasure(); });
    clickToEdit(wrap, view, this.ctx);
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

export function resolveSrc(raw: string, ctx: Pick<Ctx, "baseDir" | "toSrc">) {
  let src = raw.trim().replace(/^<|>$/g, "");
  if (/^(https?:|data:|asset:)/i.test(src)) return src;
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

const mathText = (state: EditorState, n: SyntaxNode) => {
  const m = n.getChildren("MathMark");
  return { tex: state.doc.sliceString(m[0].to, m[1].from), display: m[0].to - m[0].from === 2 };
};

function buildInline(view: EditorView, ctx: Ctx): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const sameLine = (n: SyntaxNode) => state.doc.lineAt(n.from).number === state.doc.lineAt(n.to).number;
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
          case "Table":
          case "HTMLBlock":
            return false; // rendered by blockField
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
            if (isActive(n.from) || !sameLine(n)) return false;
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
          case "InlineMath": {
            // multi-line $$...$$ is a block widget (blockField)
            if (isActive(n.from) || !sameLine(n)) return false;
            const { tex, display } = mathText(state, n);
            out.push(Decoration.replace({ widget: new MathWidget(tex, display, ctx) }).range(n.from, n.to));
            return false;
          }
          case "WikiLink":
            if (!isActive(n.from)) n.getChildren("WikiMark").forEach(m => hideMark(m.from, m.to));
            return false;
          case "FootnoteRef": {
            // "[^1]:" at the start of a line is the definition: keep its brackets visible
            const isDef = state.doc.lineAt(n.from).from === n.from && state.doc.sliceString(n.to, n.to + 1) === ":";
            if (!isDef && !isActive(n.from)) n.getChildren("FootnoteMark").forEach(m => hideMark(m.from, m.to));
            return false;
          }
          case "LinkReference": {
            const label = n.getChild("LinkLabel"); // "[^1]: word" parses as a link reference definition
            if (label && state.doc.sliceString(label.from, label.from + 2) === "[^") out.push(Decoration.mark({ class: "md-fn" }).range(label.from, label.to));
            return;
          }
        }
      },
    });
  }
  return Decoration.set(out, true);
}

/** Widgets that replace whole lines (tables, multi-line math, mermaid, raw HTML) must come from a StateField. */
function buildBlocks(state: EditorState, ctx: Ctx): DecorationSet {
  const sel = state.selection.ranges;
  const out: Range<Decoration>[] = [];
  const add = (from: number, to: number, widget: WidgetType) => {
    if (sel.some(r => r.to >= from && r.from <= to)) return;
    // Block widgets must span whole lines (blocks nested in quotes/lists stay raw).
    if (state.doc.lineAt(from).from !== from || state.doc.lineAt(to).to !== to) return;
    out.push(Decoration.replace({ widget, block: true }).range(from, to));
  };
  syntaxTree(state).iterate({
    enter: ref => {
      const { from, to } = ref;
      switch (ref.name) {
        case "Table":
          add(from, to, new TableWidget(state.doc.sliceString(from, to), ctx));
          return false;
        case "HTMLBlock":
          add(from, to, new HtmlWidget(state.doc.sliceString(from, to), ctx));
          return false;
        case "FencedCode": {
          const info = ref.node.getChild("CodeInfo");
          if (info && state.doc.sliceString(info.from, info.to).trim().toLowerCase() === "mermaid") {
            const code = ref.node.getChild("CodeText");
            add(from, to, new MermaidWidget(code ? state.doc.sliceString(code.from, code.to) : "", ctx));
          }
          return false;
        }
        case "InlineMath":
          if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
            const { tex } = mathText(state, ref.node);
            add(from, to, new MathWidget(tex, true, ctx));
          }
          return false;
        // Only descend where these blocks can live.
        case "Document": case "Blockquote": case "BulletList": case "OrderedList": case "ListItem": case "Paragraph":
          return true;
        default:
          return false;
      }
    },
  });
  return Decoration.set(out);
}

/** Walk up from a position to the link/url under it and return its target. */
function linkAt(state: EditorState, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "URL") return state.doc.sliceString(n.from, n.to);
    if (n.name === "WikiLink") return wikiHref(state.doc.sliceString(n.from + 2, n.to - 2));
    if (n.name === "Link" || n.name === "Autolink" || n.name === "Image") {
      const url = n.getChild("URL");
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

/** Ctrl+click on a footnote: reference -> its definition, definition -> first reference. */
function footnoteTarget(state: EditorState, pos: number): number | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== "FootnoteRef" && !(n.name === "LinkLabel" && n.parent?.name === "LinkReference")) continue;
    const label = state.doc.sliceString(n.from, n.to);
    if (!label.startsWith("[^")) return null;
    const doc = state.doc.toString();
    if (doc[n.to] === ":" && state.doc.lineAt(n.from).from === n.from) {
      for (let i = doc.indexOf(label); i >= 0; i = doc.indexOf(label, i + 1)) if (doc[i + label.length] !== ":") return i;
      return null;
    }
    for (let i = doc.indexOf(`${label}:`); i >= 0; i = doc.indexOf(`${label}:`, i + 1)) if (i === 0 || doc[i - 1] === "\n") return i;
    return null;
  }
  return null;
}

export function livePreview(ctx: Ctx) {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildInline(view, ctx); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildInline(u.view, ctx);
      }
    }
  }, { decorations: v => v.decorations });

  const blockField = StateField.define<DecorationSet>({
    create: s => buildBlocks(s, ctx),
    update: (deco, tr) => tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? buildBlocks(tr.state, ctx) : deco,
    provide: f => EditorView.decorations.from(f),
  });

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
        if (pos == null) return false;
        const jump = footnoteTarget(view.state, pos);
        if (jump != null) {
          view.dispatch({ selection: { anchor: jump }, effects: EditorView.scrollIntoView(jump, { y: "center" }) });
          e.preventDefault();
          return true;
        }
        const href = linkAt(view.state, pos);
        if (href) {
          ctx.openLink(href.replace(/^<|>$/g, ""));
          e.preventDefault();
          return true;
        }
      }
      return false;
    },
  });

  return [plugin, blockField, events];
}
