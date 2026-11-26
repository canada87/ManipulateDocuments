import { Compartment, EditorState, MapMode, RangeSet, RangeValue, StateField } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers, highlightSpecialChars, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, indentOnInput, bracketMatching, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion, getTauriVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { livePreview, mdHighlight, mdExtensions, resolveSrc, type Ctx } from "./livepreview";
import { decodeRaw, encodeEol, type Eol } from "./eol";
import { toHtml, printHtml } from "./export";

const APP = "NexusMD";
const REPO = "https://github.com/canada87/ManipulateDocuments";
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const ENCODINGS = ["UTF-8", "windows-1252", "windows-1250", "ISO-8859-15", "UTF-16LE", "UTF-16BE"];

interface Tab {
  id: number;
  path: string | null;
  untitled: number;
  state: EditorState;
  saved: string; // disk content, normalized to \n and without BOM
  eol: Eol; // dominant line break; the other ones live in eolField
  bom: boolean;
  enc: string;
  mtime: number | null;
  forceDirty: boolean; // e.g. file deleted on disk but kept open
  dirty: boolean;
  readOnly: boolean;
  conflict: null | "changed" | "deleted";
  scroll: number;
}

interface FileData { text: string; mtime: number | null; lossy: boolean; encoding: string }
interface SessionTab { path: string | null; untitled: number; text?: string; mtime: number | null; eol: Eol; bom: boolean; enc?: string }
interface Session { theme: string; active: number; nextUntitled: number; tabs: SessionTab[]; recent?: string[]; side?: boolean; page?: number }
/** One editor area; with a split there are two side by side. A tab is shown in at most one pane. */
interface Pane { el: HTMLElement; view: EditorView; tab: Tab }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs: Tab[] = [];
let active: Tab;
let nextId = 1;
let nextUntitled = 1;
let busy = 0; // >0 while we write files, so the disk watcher ignores our own mtime changes
let version = "";
let recent: string[] = [];
let pageWidth = 880;
const panes: Pane[] = [];
let view: EditorView; // the focused pane's view
const mode = new Compartment();

// ---------- helpers ----------
const isMd = (t: Tab) => !t.path || MD_EXT.test(t.path);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirOf = (p: string | null) => (p ? p.replace(/[\\/][^\\/]*$/, "") : null);
const title = (t: Tab) => (t.path ? baseName(t.path) : `Untitled-${t.untitled}`);
const join = (dir: string, name: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;
// shortcut: case-insensitive path compare (right on Windows/macOS, rare false match on Linux).
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
const docText = (t: Tab) => t.state.doc.toString();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function computeDirty(t: Tab) {
  return t.forceDirty || t.state.doc.length !== t.saved.length || docText(t) !== t.saved;
}

// ---------- line endings ----------
/** Marks a "\n" that was a non-dominant break on disk; dropped when that break is deleted. */
class EolMark extends RangeValue {
  startSide = 1; endSide = 1; point = true; mapMode = MapMode.TrackAfter;
  constructor(readonly eol: Eol) { super(); }
  eq(o: EolMark) { return o.eol === this.eol; }
}
const eolField = StateField.define<RangeSet<EolMark>>({ create: () => RangeSet.empty, update: (v, tr) => v.map(tr.changes) });

function serialize(t: Tab) {
  const odd = new Map<number, Eol>();
  t.state.field(eolField).between(0, t.state.doc.length, (p, _to, v) => { odd.set(p, v.eol); });
  return (t.bom ? "﻿" : "") + encodeEol(docText(t), t.eol, odd);
}

// ---------- editor ----------
const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-text)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)", padding: "28px 0 40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--sel) !important" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--bg2)", color: "var(--fg)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--match)", outline: "1px solid var(--accent2)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-textfield": { background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-button": { backgroundImage: "none", background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" },
}, { dark: true });

const ctxOf = (t: Tab): Ctx => ({ baseDir: () => dirOf(t.path), toSrc: convertFileSrc, openLink: href => openLink(t, href) });

function modeExt(t: Tab) {
  return isMd(t)
    ? [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: mdExtensions }),
        syntaxHighlighting(mdHighlight),
        livePreview(ctxOf(t)),
      ]
    : [lineNumbers(), highlightActiveLine()];
}

const onUpdate = EditorView.updateListener.of(u => {
  const t = panes.find(p => p.view === u.view)?.tab;
  if (!t) return;
  t.state = u.state;
  if (u.docChanged) {
    const d = computeDirty(t);
    if (d !== t.dirty) { t.dirty = d; renderTabs(); }
    persistSoon();
    if (t === active) outlineSoon();
  }
  if (t === active && (u.docChanged || u.selectionSet)) renderStatus();
});

function makeState(t: Tab, text: string, odd: [number, Eol][] = []) {
  return EditorState.create({
    doc: text,
    extensions: [
      history(), drawSelection(), highlightSpecialChars(), rectangularSelection(), indentOnInput(), bracketMatching(), highlightSelectionMatches(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorState.readOnly.of(t.readOnly),
      editorTheme,
      mode.of(modeExt(t)),
      eolField.init(() => RangeSet.of(odd.map(([p, e]) => new EolMark(e).range(p)))),
      onUpdate,
    ],
  });
}

// ---------- panes (split view) ----------
const paneOf = (t: Tab) => panes.find(p => p.tab === t);

function makePane(atStart: boolean): Pane {
  const el = Object.assign(document.createElement("div"), { className: "frame" });
  el.innerHTML = `<div class="editor"></div><div class="guide" title="Drag: page width · Double-click: reset"></div><button class="unsplit" title="Close this pane">×</button>`;
  const p: Pane = { el, view: new EditorView({ parent: el.querySelector<HTMLElement>(".editor")! }), tab: null as unknown as Tab };
  $("panes").insertBefore(el, atStart ? $("panes").firstChild : $("drop"));
  if (atStart) panes.unshift(p); else panes.push(p);
  el.addEventListener("focusin", () => { if (p.tab !== active) activate(p.tab, p); });
  el.querySelector<HTMLElement>(".unsplit")!.onclick = () => unsplit(p);
  const guide = el.querySelector<HTMLElement>(".guide")!;
  guide.onpointerdown = e => dragGuide(p, e);
  guide.ondblclick = () => { setPageWidth(880); persistSoon(); };
  // The guide sits on the text column's right edge, which moves with the page width and the pane size.
  const ro = new ResizeObserver(() => placeGuide(p));
  ro.observe(p.view.contentDOM);
  ro.observe(el);
  return p;
}

function placeGuide(p: Pane) {
  const right = p.view.contentDOM.getBoundingClientRect().right - p.el.getBoundingClientRect().left;
  p.el.querySelector<HTMLElement>(".guide")!.style.left = `${Math.min(right, p.view.scrollDOM.clientWidth) - 4}px`;
}

function setPageWidth(w: number) {
  pageWidth = Math.max(320, Math.round(w));
  document.documentElement.style.setProperty("--page", `${pageWidth}px`);
  panes.forEach(p => p.view.requestMeasure());
}

function dragGuide(p: Pane, down: PointerEvent) {
  const g = down.target as HTMLElement;
  const left = p.view.contentDOM.getBoundingClientRect().left; // the column is left-aligned
  g.setPointerCapture(down.pointerId);
  g.classList.add("on");
  g.onpointermove = e => setPageWidth(e.clientX - left);
  g.onpointerup = () => { g.onpointermove = g.onpointerup = null; g.classList.remove("on"); persistSoon(); };
}

/** Put `t` in pane `p`; if `t` was in the other pane, the two panes swap tabs. */
function show(p: Pane, t: Tab) {
  const q = paneOf(t), old = p.tab;
  if (old) old.scroll = p.view.scrollDOM.scrollTop;
  if (q) t.scroll = q.view.scrollDOM.scrollTop;
  p.tab = t;
  setView(p);
  p.view.scrollDOM.scrollTop = t.scroll;
  if (q && q !== p && old) { q.tab = old; setView(q); q.view.scrollDOM.scrollTop = old.scroll; }
}

function setView(p: Pane) {
  p.view.setState(p.tab.state);
  p.el.classList.toggle("plain", !isMd(p.tab));
}

/** A tab dropped on the left/right half of the editor area: show it there, splitting if needed. */
function dropTab(t: Tab, right: boolean) {
  if (panes.length > 1) return activate(t, panes[right ? 1 : 0]);
  const only = panes[0];
  if (only.tab === t) {
    const i = tabs.indexOf(t), other = tabs[i - 1] ?? tabs[i + 1];
    if (!other) return; // a single tab has nothing to sit beside
    show(only, other);
  }
  activate(t, makePane(!right));
}

/** Close pane `p`; the other pane stays as it is. */
function unsplit(p: Pane) {
  if (panes.length < 2) return;
  panes.splice(panes.indexOf(p), 1);
  p.view.destroy();
  p.el.remove();
  activate(panes[0].tab, panes[0]);
}

// ---------- tabs ----------
function newTab(path: string | null, data: FileData | null, current?: string): Tab {
  const { text: saved, eol, bom, odd } = decodeRaw(data?.text ?? "");
  const t: Tab = {
    id: nextId++, path, untitled: path ? 0 : nextUntitled++, state: null as unknown as EditorState,
    saved, eol, bom, enc: data?.encoding ?? "UTF-8", mtime: data?.mtime ?? null,
    forceDirty: false, dirty: false, readOnly: !!data?.lossy, conflict: null, scroll: 0,
  };
  // shortcut: unsaved text restored from the session loses its mixed-EOL marks (dominant EOL only); store marks in the session if that matters.
  t.state = makeState(t, current ?? saved, current == null ? odd : []);
  t.dirty = computeDirty(t);
  return t;
}

/** Replace a tab's content with what was just read from disk. */
function loadInto(t: Tab, data: FileData) {
  const { text, eol, bom, odd } = decodeRaw(data.text);
  Object.assign(t, { saved: text, eol, bom, enc: data.encoding, mtime: data.mtime, readOnly: data.lossy, forceDirty: false, conflict: null });
  t.state = makeState(t, text, odd);
  const p = paneOf(t);
  if (p) setView(p);
  t.dirty = computeDirty(t);
}

/** Make `t` the active tab: focus the pane showing it, or show it in pane `p` (default: the focused one). */
function activate(t: Tab, p = paneOf(t) ?? paneOf(active) ?? panes[0]) {
  if (p.tab !== t) show(p, t);
  active = t;
  view = p.view;
  panes.forEach(x => x.el.classList.toggle("focused", x === p && panes.length > 1));
  renderTabs();
  renderStatus();
  renderBanner();
  renderSide();
  view.focus();
  persistSoon();
}

function addTab(t: Tab) {
  // Replace a lone pristine "Untitled" tab, like Notepad++.
  const lone = tabs.length === 1 && !tabs[0].path && !tabs[0].dirty ? tabs[0] : null;
  if (lone) tabs.splice(0, 1, t); else tabs.push(t);
  activate(t);
}

async function openFiles(paths: string[]) {
  for (const p of paths) {
    const existing = tabs.find(t => t.path && samePath(t.path, p));
    if (existing) { activate(existing); continue; }
    try {
      let data = await invoke<FileData>("read_file", { path: p });
      if (data.lossy) {
        const enc = await dialog("Not UTF-8", `${baseName(p)} is not valid UTF-8 text. Pick its encoding (windows-1252 is the usual one for Western European text), or open it read-only so saving can't corrupt it.`, [...ENCODINGS.slice(1), "Read-only"]);
        if (!enc) continue;
        if (enc !== "Read-only") data = await invoke<FileData>("read_file", { path: p, encoding: enc });
      }
      addTab(newTab(p, data));
      addRecent(p);
    } catch (e) {
      recent = recent.filter(r => !samePath(r, p));
      renderRecent();
      await dialog("Cannot open file", `${p}\n\n${errText(e)}`, ["OK"]);
    }
  }
}

async function openDialog() {
  const sel = await open({
    multiple: true,
    defaultPath: dirOf(active?.path ?? null) ?? undefined,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }, { name: "All files", extensions: ["*"] }],
  });
  if (sel) await openFiles(Array.isArray(sel) ? sel : [sel]);
}

async function saveTab(t: Tab, as = false): Promise<boolean> {
  if (t.readOnly) { await dialog("Read-only", "This file is not UTF-8 and was opened read-only.", ["OK"]); return false; }
  let path = t.path;
  if (!path || as) {
    path = await save({
      defaultPath: t.path ?? `${title(t)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "All files", extensions: ["*"] }],
    });
    if (!path) return false;
  }
  const text = docText(t);
  busy++;
  try {
    t.mtime = await invoke<number | null>("write_file", { path, text: serialize(t), encoding: t.enc });
  } catch (e) {
    await dialog("Save failed", `${path}\n\n${errText(e)}`, ["OK"]);
    return false;
  } finally {
    busy--;
  }
  const wasMd = isMd(t);
  t.path = path;
  t.saved = text;
  t.forceDirty = false;
  t.conflict = null;
  t.dirty = computeDirty(t);
  if (wasMd !== isMd(t)) {
    t.state = t.state.update({ effects: mode.reconfigure(modeExt(t)) }).state;
    const p = paneOf(t);
    if (p) setView(p);
  }
  addRecent(path);
  renderTabs(); renderStatus(); renderBanner(); renderSide(true); persistSoon();
  return true;
}

async function closeTab(t: Tab) {
  if (t.dirty) {
    const r = await dialog("Unsaved changes", `Save changes to ${title(t)} before closing?`, ["Save", "Don't save", "Cancel"]);
    if (r === "Cancel" || r === null) return;
    if (r === "Save" && !(await saveTab(t))) return;
  }
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(newTab(null, null));
  const p = paneOf(t);
  if (!p) { renderTabs(); persistSoon(); return; }
  const free = tabs.filter(x => !paneOf(x));
  if (!free.length) return unsplit(p); // the only tab left is already in the other pane
  activate(free[Math.min(i, free.length - 1)], p);
}

function openLink(t: Tab, href: string) {
  if (/^(https?:|mailto:)/i.test(href)) { openUrl(href); return; }
  const dir = dirOf(t.path);
  let p = href.split("#")[0];
  try { p = decodeURI(p); } catch { /* keep raw */ }
  if (!p) return;
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) { if (!dir) return; p = `${dir}/${p}`; }
  if (MD_EXT.test(p)) openFiles([p]); else openPath(p);
}

// ---------- disk watcher ----------
async function checkDisk() {
  if (busy) return;
  const watched = tabs.filter(t => t.path && !t.conflict);
  if (!watched.length) return;
  let ms: (number | null)[];
  try { ms = await invoke("mtimes", { paths: watched.map(t => t.path) }); } catch { return; }
  if (busy) return;
  let changed = false;
  watched.forEach((t, i) => {
    if (ms[i] !== t.mtime) { t.conflict = ms[i] == null ? "deleted" : "changed"; changed = true; }
  });
  if (changed) { renderTabs(); renderBanner(); }
}

async function resolveConflict(t: Tab, action: "reload" | "ignore" | "keep" | "close") {
  if (action === "close") { t.conflict = null; t.dirty = false; return closeTab(t); }
  if (action === "keep") { t.forceDirty = true; t.mtime = null; }
  else {
    let data: FileData;
    try { data = await invoke<FileData>("read_file", { path: t.path, encoding: t.enc }); }
    catch (e) { await dialog("Cannot read file", errText(e), ["OK"]); return; }
    if (action === "reload") loadInto(t, data);
    else { t.saved = decodeRaw(data.text).text; t.mtime = data.mtime; }
  }
  t.conflict = null;
  t.dirty = computeDirty(t);
  renderTabs(); renderStatus(); renderBanner(); persistSoon();
}

// ---------- session (Notepad++-style: unsaved edits survive restarts) ----------
let persistTimer = 0;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistNow, 800);
}
async function persistNow() {
  clearTimeout(persistTimer);
  const s: Session = {
    theme: document.documentElement.dataset.theme!,
    active: tabs.indexOf(active),
    nextUntitled,
    recent,
    side: !$("side").hidden,
    page: pageWidth,
    tabs: tabs.map(t => ({
      path: t.path, untitled: t.untitled, mtime: t.mtime, eol: t.eol, bom: t.bom, enc: t.enc,
      ...(t.dirty ? { text: docText(t) } : {}),
    })),
  };
  // shortcut: whole session rewritten as one JSON file; switch to per-tab backup files if huge docs get slow.
  try { await invoke("save_session", { data: JSON.stringify(s) }); } catch (e) { console.error("session save failed", e); }
}

async function restore(s: Session) {
  setTheme(s.theme);
  nextUntitled = s.nextUntitled || 1;
  recent = s.recent ?? [];
  renderRecent();
  $("side").hidden = !s.side;
  if (s.page) setPageWidth(s.page);
  for (const st of s.tabs) {
    if (!st.path) {
      const t = newTab(null, null, st.text);
      t.untitled = st.untitled;
      tabs.push(t);
      continue;
    }
    let disk: FileData | null = null;
    try { disk = await invoke<FileData>("read_file", { path: st.path, encoding: st.enc }); } catch { /* missing */ }
    if (!disk && st.text == null) continue; // gone, and nothing unsaved to keep
    const t = newTab(st.path, disk, st.text);
    t.bom = st.bom;
    if (st.text != null || !disk) t.eol = st.eol;
    if (st.enc) t.enc = st.enc;
    if (!disk) { t.forceDirty = true; t.dirty = true; }
    // Keep the old baseline for dirty tabs so the watcher flags files changed while we were closed.
    else if (st.text != null) t.mtime = st.mtime;
    tabs.push(t);
  }
  nextUntitled = Math.max(nextUntitled, ...tabs.map(t => t.untitled + 1));
  return tabs[s.active] ?? tabs[0];
}

// ---------- UI rendering ----------
function renderTabs() {
  const bar = $("tabs");
  const add = Object.assign(document.createElement("button"), { className: "add", textContent: "+", title: "New (Ctrl+N)" });
  add.onclick = () => addTab(newTab(null, null));
  bar.replaceChildren(...tabs.map(t => {
    const el = document.createElement("div");
    el.className = `tab${t === active ? " active" : paneOf(t) ? " shown" : ""}${t.dirty ? " dirty" : ""}${t.conflict ? " conflict" : ""}`;
    el.title = t.path ?? "Not saved yet";
    el.setAttribute("role", "tab");
    el.innerHTML = `<span class="dot"></span><span class="name"></span><button class="x" title="Close (Ctrl+W)">×</button>`;
    el.querySelector(".name")!.textContent = title(t);
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } };
    el.onpointerdown = e => { if (e.button === 0 && !(e.target as HTMLElement).classList.contains("x")) dragTab(t, e); };
    el.onclick = e => { if ((e.target as HTMLElement).classList.contains("x")) closeTab(t); else if (t !== active) activate(t); };
    return el;
  }), add);
  bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  panes.forEach(p => p.el.classList.toggle("dirty", p.tab.dirty));
  const winTitle = `${active.dirty ? "● " : ""}${title(active)} — ${APP}`;
  document.title = winTitle;
  try { getCurrentWindow().setTitle(winTitle).catch(() => {}); } catch { /* not running inside Tauri */ }
}

/** Reorder tabs by dragging, or drop one on the editor's left/right half to split
 *  (pointer events: the webview's native drag & drop is taken by file drops). */
function dragTab(t: Tab, down: PointerEvent) {
  let moved = false;
  let side: "left" | "right" | null = null;
  const drop = $("drop");
  const move = (e: PointerEvent) => {
    if (!moved && Math.abs(e.clientX - down.clientX) < 6 && Math.abs(e.clientY - down.clientY) < 6) return;
    moved = true;
    const a = $("panes").getBoundingClientRect();
    side = e.clientY > a.top && e.clientX > a.left && e.clientX < a.right ? (e.clientX > a.left + a.width / 2 ? "right" : "left") : null;
    drop.hidden = !side;
    if (side) { drop.className = `drop ${side}`; return; }
    const over = (document.elementFromPoint(e.clientX, down.clientY) as HTMLElement | null)?.closest<HTMLElement>(".tab");
    const to = over ? [...$("tabs").children].indexOf(over) : -1;
    const from = tabs.indexOf(t);
    if (to < 0 || to === from) return;
    // swap only past the target's middle, so tabs of different widths don't flip back and forth
    const r = over!.getBoundingClientRect();
    if (to > from ? e.clientX < r.left + r.width / 2 : e.clientX > r.left + r.width / 2) return;
    tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    renderTabs();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    drop.hidden = true;
    if (side) dropTab(t, side === "right");
    else if (moved) persistSoon();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function renderStatus() {
  const t = active;
  const st = $("st-state");
  st.textContent = t.readOnly ? "READ-ONLY" : t.dirty ? "● UNSAVED" : "SAVED";
  st.className = `chip ${t.readOnly ? "ro" : t.dirty ? "unsaved" : "saved"}`;
  $("st-path").textContent = t.path ?? "New document — never saved";
  const head = t.state.selection.main.head;
  const line = t.state.doc.lineAt(head);
  $("st-pos").textContent = `LN ${line.number}  COL ${head - line.from + 1}`;
  const eol = { "\n": "LF", "\r\n": "CRLF", "\r": "CR" }[t.eol];
  $("st-fmt").textContent = `${isMd(t) ? "MD" : "TXT"} · ${t.enc}${t.bom ? " BOM" : ""} · ${eol}${t.state.field(eolField).size ? " MIXED" : ""}`;
}

function renderBanner() {
  const b = $("banner");
  const t = active;
  if (!t.conflict) { b.hidden = true; return; }
  b.hidden = false;
  const actions: [string, Parameters<typeof resolveConflict>[1]][] = t.conflict === "changed"
    ? [["Reload from disk", "reload"], ["Ignore (keep mine, overwrite on save)", "ignore"]]
    : [["Keep in editor", "keep"], ["Close tab", "close"]];
  b.innerHTML = `<span class="msg"></span>`;
  b.querySelector(".msg")!.textContent = t.conflict === "changed"
    ? `⚠ ${title(t)} was modified outside ${APP}.`
    : `⚠ ${title(t)} was deleted or moved on disk.`;
  for (const [label, act] of actions) {
    const btn = Object.assign(document.createElement("button"), { textContent: label });
    btn.onclick = () => resolveConflict(t, act);
    b.append(btn);
  }
}

async function changeEncoding(t: Tab) {
  const how = !t.path ? "Save with…" : t.readOnly ? "Reopen with…"
    : await dialog("Encoding", `${title(t)} is ${t.enc}. Reopen it from disk with another encoding, or keep the text and save it with another one.`, ["Reopen with…", "Save with…", "Cancel"]);
  if (how !== "Reopen with…" && how !== "Save with…") return;
  const reopen = how === "Reopen with…";
  const enc = await dialog(reopen ? "Reopen with encoding" : "Save with encoding",
    reopen ? `Read ${title(t)} again from disk as:${t.dirty ? "\n(unsaved changes will be lost)" : ""}` : "Next saves will use:", [...ENCODINGS, "Cancel"]);
  if (!enc || enc === "Cancel") return;
  if (!reopen) { t.enc = enc; t.forceDirty = !!t.path; t.dirty = computeDirty(t); }
  else {
    try { loadInto(t, await invoke<FileData>("read_file", { path: t.path, encoding: enc })); }
    catch (e) { await dialog("Cannot read file", errText(e), ["OK"]); return; }
    if (t.readOnly) await dialog("Still not readable", `${title(t)} has bytes that are not valid ${enc}. It stays read-only.`, ["OK"]);
  }
  renderTabs(); renderStatus(); renderBanner(); persistSoon();
}

// ---------- sidebar: folder tree + outline ----------
const expanded = new Set<string>();
let treeRoot: string | null | undefined;

function renderSide(force = false) {
  if ($("side").hidden) return;
  renderOutline();
  const root = dirOf(active.path);
  if (root === treeRoot && !force) { markActiveFile(); return; }
  treeRoot = root;
  const box = $("tree");
  if (!root) { box.textContent = "Save the document to browse its folder."; return; }
  expanded.add(root);
  box.replaceChildren(dirEl(root, baseName(root)));
}

function dirEl(path: string, name: string) {
  const d = document.createElement("details");
  d.innerHTML = `<summary class="node dir"></summary><div class="kids"></div>`;
  const sum = d.querySelector("summary")!;
  sum.textContent = name;
  sum.title = path;
  // Listed on every open, so re-opening a folder refreshes it.
  d.ontoggle = async () => {
    if (!d.open) { expanded.delete(path); return; }
    expanded.add(path);
    const kids = d.querySelector(".kids")!;
    try {
      const list = await invoke<{ name: string; dir: boolean }[]>("list_dir", { path });
      kids.replaceChildren(...list.filter(e => e.dir || MD_EXT.test(e.name)).map(e => (e.dir ? dirEl : fileEl)(join(path, e.name), e.name)));
    } catch (e) { kids.textContent = errText(e); }
    markActiveFile();
  };
  d.open = expanded.has(path);
  return d;
}

function fileEl(path: string, name: string) {
  const el = Object.assign(document.createElement("div"), { className: "node file", textContent: name, title: path });
  el.dataset.path = path;
  el.onclick = () => openFiles([path]);
  return el;
}

function markActiveFile() {
  $("tree").querySelectorAll<HTMLElement>(".file").forEach(el => el.classList.toggle("active", !!active.path && samePath(el.dataset.path!, active.path)));
}

let outlineTimer = 0;
function outlineSoon() {
  clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(renderOutline, 300);
}

function renderOutline() {
  const box = $("outline");
  if ($("side").hidden) return;
  if (!isMd(active)) { box.textContent = "No outline for plain text."; return; }
  const st = active.state;
  const items: HTMLElement[] = [];
  (ensureSyntaxTree(st, st.doc.length, 100) ?? syntaxTree(st)).iterate({
    enter: n => {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(n.name);
      if (!m) return n.name === "Document";
      const line = st.doc.lineAt(n.from);
      const text = m[1] === "ATX" ? line.text.replace(/^\s*#+\s*|\s+#+\s*$/g, "") : line.text.trim();
      const el = Object.assign(document.createElement("div"), { className: `node h${m[2]}`, textContent: text || "(empty)" });
      el.onclick = () => {
        view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 20 }) });
        view.focus();
      };
      items.push(el);
      return false;
    },
  });
  if (items.length) box.replaceChildren(...items); else box.textContent = "No headings.";
}

function toggleSide() {
  $("side").hidden = !$("side").hidden;
  treeRoot = undefined;
  renderSide();
  persistSoon();
  view.focus();
}

// ---------- recent files ----------
function addRecent(p: string) {
  recent = [p, ...recent.filter(r => !samePath(r, p))].slice(0, 12);
  renderRecent();
}

function renderRecent() {
  const sel = $<HTMLSelectElement>("recent");
  sel.replaceChildren(new Option("RECENT", ""), ...recent.map(p => new Option(`${baseName(p)}  —  ${dirOf(p)}`, p)));
  sel.value = "";
}

// ---------- export ----------
async function exportDoc(t: Tab, how: string) {
  try {
    if (how === "html") {
      const path = await save({
        defaultPath: `${(t.path ?? title(t)).replace(MD_EXT, "")}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (path) await invoke("write_file", { path, text: await toHtml(docText(t), title(t)) });
    } else if (how === "pdf") {
      printHtml(await toHtml(docText(t), title(t), src => resolveSrc(src, ctxOf(t)) || src));
    }
  } catch (e) {
    await dialog("Export failed", errText(e), ["OK"]);
  }
}

function setTheme(name: string) {
  const ok = ["dystopia", "phosphor", "synthwave"].includes(name) ? name : "dystopia";
  document.documentElement.dataset.theme = ok;
  $("settings").querySelectorAll<HTMLElement>("[data-set-theme]").forEach(b => b.classList.toggle("on", b.dataset.setTheme === ok));
}

/** In-app modal; resolves with the clicked label, or null on Esc. */
function dialog(head: string, body: string, buttons: string[], html = false): Promise<string | null> {
  return new Promise(resolve => {
    const modal = $("modal"), box = $("modal-box");
    box.innerHTML = `<h2></h2><div class="body"></div><div class="actions"></div>`;
    box.querySelector("h2")!.textContent = head;
    const bodyEl = box.querySelector(".body")!;
    if (html) bodyEl.innerHTML = body; else bodyEl.textContent = body;
    const done = (v: string | null) => { modal.hidden = true; document.removeEventListener("keydown", onKey, true); resolve(v); view.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    buttons.forEach((label, i) => {
      const b = Object.assign(document.createElement("button"), { textContent: label, className: i === 0 ? "primary" : "" });
      b.onclick = () => done(label);
      box.querySelector(".actions")!.append(b);
    });
    modal.hidden = false;
    (box.querySelector("button.primary") as HTMLButtonElement | null)?.focus();
  });
}

async function about() {
  const tauri = await getTauriVersion().catch(() => "?");
  dialog(`${APP}  v${version}`, `
    <p>Fast standalone Markdown editor.</p>
    <table class="kv">
      <tr><td>Version</td><td>${version}</td></tr>
      <tr><td>Tauri</td><td>${tauri}</td></tr>
      <tr><td>Source</td><td>${REPO}</td></tr>
    </table>
    <h3>Shortcuts</h3>
    <table class="kv">
      <tr><td>Ctrl+N / Ctrl+O</td><td>New / Open</td></tr>
      <tr><td>Ctrl+S / Ctrl+Shift+S</td><td>Save / Save as</td></tr>
      <tr><td>Ctrl+W</td><td>Close tab</td></tr>
      <tr><td>Ctrl+B</td><td>Folder &amp; outline sidebar</td></tr>
      <tr><td>Ctrl+Tab / Ctrl+Shift+Tab</td><td>Next / previous tab</td></tr>
      <tr><td>Ctrl+F</td><td>Find &amp; replace</td></tr>
      <tr><td>Ctrl+Click</td><td>Open link or [[wikilink]]; jump between a footnote and its text</td></tr>
      <tr><td>Drag a tab</td><td>Reorder tabs; drop it on the left/right half of the editor to view two side by side</td></tr>
      <tr><td>Drag the page edge line</td><td>Page width (double-click resets)</td></tr>
      <tr><td>Click the encoding</td><td>Reopen or save with another encoding</td></tr>
    </table>`, ["Close"], true);
}

// ---------- wiring ----------
document.addEventListener("keydown", e => {
  if (!$("modal").hidden) return;
  if (e.key === "Escape" && !$("settings").hidden) { $("settings").hidden = true; view.focus(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  const run = (fn: () => unknown) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (k === "s") run(() => saveTab(active, e.shiftKey));
  else if (k === "o") run(openDialog);
  else if (k === "n") run(() => addTab(newTab(null, null)));
  else if (k === "w") run(() => closeTab(active));
  else if (k === "b") run(toggleSide);
  else if (k === "tab") run(() => activate(tabs[(tabs.indexOf(active) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]));
}, true);

$("btn-open").onclick = openDialog;
$("btn-save").onclick = () => saveTab(active);
$("st-ver").onclick = about;
$("st-fmt").onclick = () => changeEncoding(active);
$("btn-side").onclick = toggleSide;
$<HTMLSelectElement>("recent").onchange = e => {
  const sel = e.target as HTMLSelectElement, p = sel.value;
  sel.value = "";
  if (p) openFiles([p]); else view.focus();
};
$("btn-settings").onclick = () => { $("settings").hidden = !$("settings").hidden; };
document.addEventListener("pointerdown", e => {
  if (!(e.target as HTMLElement).closest(".menu-wrap")) $("settings").hidden = true;
});
$("settings").onclick = e => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  $("settings").hidden = true;
  view.focus();
  if (b.dataset.export) exportDoc(active, b.dataset.export);
  else if (b.dataset.setTheme) { setTheme(b.dataset.setTheme); persistNow(); }
  else about();
};

makePane(false);
view = panes[0].view;
setTheme("dystopia"); // marks the default in the menu; the session overrides it

async function start() {
  version = await getVersion().catch(() => "dev");
  $("st-ver").textContent = `v${version}`;
  let first: Tab | undefined;
  try {
    const raw = await invoke<string | null>("load_session");
    if (raw) first = await restore(JSON.parse(raw));
  } catch (e) { console.error("session restore failed", e); }
  if (!tabs.length) tabs.push(newTab(null, null));
  activate(first ?? tabs[0]);

  await openFiles(await invoke<string[]>("launch_files").catch(() => []));
  await listen<string[]>("open-files", e => openFiles(e.payload));
  await getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === "drop") openFiles(e.payload.paths); });
  // Window close never asks: unsaved work is kept in the session, like Notepad++.
  await getCurrentWindow().onCloseRequested(async () => { await persistNow(); });
  window.addEventListener("focus", () => { checkDisk(); renderSide(true); });
  setInterval(checkDisk, 2000);
}

start();
