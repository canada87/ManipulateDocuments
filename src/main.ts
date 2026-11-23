import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers, highlightSpecialChars, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion, getTauriVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { livePreview, mdHighlight } from "./livepreview";

const APP = "NexusMD";
const REPO = "https://github.com/canada87/ManipulateDocuments";
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;

interface Tab {
  id: number;
  path: string | null;
  untitled: number;
  state: EditorState;
  saved: string; // disk content, normalized to \n and without BOM
  eol: "\n" | "\r\n";
  bom: boolean;
  mtime: number | null;
  forceDirty: boolean; // e.g. file deleted on disk but kept open
  dirty: boolean;
  readOnly: boolean;
  conflict: null | "changed" | "deleted";
  scroll: number;
}

interface FileData { text: string; mtime: number | null; lossy: boolean }
interface SessionTab { path: string | null; untitled: number; text?: string; mtime: number | null; eol: Tab["eol"]; bom: boolean }
interface Session { theme: string; active: number; nextUntitled: number; tabs: SessionTab[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs: Tab[] = [];
let active: Tab;
let nextId = 1;
let nextUntitled = 1;
let busy = 0; // >0 while we write files, so the disk watcher ignores our own mtime changes
let version = "";
const mode = new Compartment();

// ---------- helpers ----------
const isMd = (t: Tab) => !t.path || MD_EXT.test(t.path);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirOf = (p: string | null) => (p ? p.replace(/[\\/][^\\/]*$/, "") : null);
const title = (t: Tab) => (t.path ? baseName(t.path) : `Untitled-${t.untitled}`);
// shortcut: case-insensitive path compare (right on Windows/macOS, rare false match on Linux).
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
const docText = (t: Tab) => t.state.doc.toString();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function computeDirty(t: Tab) {
  return t.forceDirty || t.state.doc.length !== t.saved.length || docText(t) !== t.saved;
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

function modeExt(t: Tab) {
  return isMd(t)
    ? [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(mdHighlight),
        livePreview({ baseDir: () => dirOf(t.path), toSrc: convertFileSrc, openLink: href => openLink(t, href) }),
      ]
    : [lineNumbers(), highlightActiveLine()];
}

const onUpdate = EditorView.updateListener.of(u => {
  active.state = u.state;
  if (u.docChanged) {
    const d = computeDirty(active);
    if (d !== active.dirty) { active.dirty = d; renderTabs(); }
    persistSoon();
  }
  if (u.docChanged || u.selectionSet) renderStatus();
});

function makeState(t: Tab, text: string) {
  return EditorState.create({
    doc: text,
    extensions: [
      history(), drawSelection(), highlightSpecialChars(), rectangularSelection(), indentOnInput(), bracketMatching(), highlightSelectionMatches(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorState.readOnly.of(t.readOnly),
      editorTheme,
      mode.of(modeExt(t)),
      onUpdate,
    ],
  });
}

const view = new EditorView({ parent: $("editor") });

// ---------- tabs ----------
function newTab(path: string | null, data: { text: string; mtime: number | null; lossy?: boolean } | null, current?: string): Tab {
  const raw = data?.text ?? "";
  const bom = raw.startsWith("﻿");
  const saved = normalize(bom ? raw.slice(1) : raw);
  const t: Tab = {
    id: nextId++, path, untitled: path ? 0 : nextUntitled++, state: null as unknown as EditorState,
    saved, eol: raw.includes("\r\n") ? "\r\n" : "\n", bom, mtime: data?.mtime ?? null,
    forceDirty: false, dirty: false, readOnly: !!data?.lossy, conflict: null, scroll: 0,
  };
  t.state = makeState(t, current ?? saved);
  t.dirty = computeDirty(t);
  return t;
}

function activate(t: Tab) {
  if (active && active !== t) active.scroll = view.scrollDOM.scrollTop;
  active = t;
  view.setState(t.state);
  view.scrollDOM.scrollTop = t.scroll;
  $("frame").classList.toggle("plain", !isMd(t));
  renderTabs();
  renderStatus();
  renderBanner();
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
      const data = await invoke<FileData>("read_file", { path: p });
      addTab(newTab(p, data));
      if (data.lossy) await dialog("Not UTF-8", `${baseName(p)} is not valid UTF-8 text. It is opened read-only so saving can't corrupt it.`, ["OK"]);
    } catch (e) {
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
    t.mtime = await invoke<number | null>("write_file", { path, text: (t.bom ? "﻿" : "") + text.replace(/\n/g, t.eol) });
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
    if (t === active) activate(t);
  }
  renderTabs(); renderStatus(); renderBanner(); persistSoon();
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
  if (active === t) activate(tabs[Math.min(i, tabs.length - 1)]);
  else { renderTabs(); persistSoon(); }
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
    try { data = await invoke<FileData>("read_file", { path: t.path }); }
    catch (e) { await dialog("Cannot read file", errText(e), ["OK"]); return; }
    const raw = data.text.startsWith("﻿") ? data.text.slice(1) : data.text;
    t.saved = normalize(raw);
    t.mtime = data.mtime;
    if (action === "reload") {
      t.state = makeState(t, t.saved);
      if (t === active) view.setState(t.state);
    }
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
    tabs: tabs.map(t => ({
      path: t.path, untitled: t.untitled, mtime: t.mtime, eol: t.eol, bom: t.bom,
      ...(t.dirty ? { text: docText(t) } : {}),
    })),
  };
  // shortcut: whole session rewritten as one JSON file; switch to per-tab backup files if huge docs get slow.
  try { await invoke("save_session", { data: JSON.stringify(s) }); } catch (e) { console.error("session save failed", e); }
}

async function restore(s: Session) {
  setTheme(s.theme);
  nextUntitled = s.nextUntitled || 1;
  for (const st of s.tabs) {
    if (!st.path) {
      const t = newTab(null, null, st.text);
      t.untitled = st.untitled;
      tabs.push(t);
      continue;
    }
    let disk: FileData | null = null;
    try { disk = await invoke<FileData>("read_file", { path: st.path }); } catch { /* missing */ }
    if (!disk && st.text == null) continue; // gone, and nothing unsaved to keep
    const t = newTab(st.path, disk, st.text);
    t.eol = st.eol; t.bom = st.bom;
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
  bar.replaceChildren(...tabs.map(t => {
    const el = document.createElement("div");
    el.className = `tab${t === active ? " active" : ""}${t.dirty ? " dirty" : ""}${t.conflict ? " conflict" : ""}`;
    el.title = t.path ?? "Not saved yet";
    el.setAttribute("role", "tab");
    el.innerHTML = `<span class="dot"></span><span class="name"></span><button class="x" title="Close (Ctrl+W)">×</button>`;
    el.querySelector(".name")!.textContent = title(t);
    el.onmousedown = e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } };
    el.onclick = e => { if ((e.target as HTMLElement).classList.contains("x")) closeTab(t); else if (t !== active) activate(t); };
    return el;
  }));
  bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.body.classList.toggle("dirty", active.dirty);
  const winTitle = `${active.dirty ? "● " : ""}${title(active)} — ${APP}`;
  document.title = winTitle;
  try { getCurrentWindow().setTitle(winTitle).catch(() => {}); } catch { /* not running inside Tauri */ }
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
  $("st-fmt").textContent = `${isMd(t) ? "MD" : "TXT"} · UTF-8${t.bom ? " BOM" : ""} · ${t.eol === "\r\n" ? "CRLF" : "LF"}`;
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

function setTheme(name: string) {
  const ok = ["dystopia", "phosphor", "synthwave"].includes(name) ? name : "dystopia";
  document.documentElement.dataset.theme = ok;
  $<HTMLSelectElement>("theme").value = ok;
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
      <tr><td>Ctrl+Tab / Ctrl+Shift+Tab</td><td>Next / previous tab</td></tr>
      <tr><td>Ctrl+F</td><td>Find &amp; replace</td></tr>
      <tr><td>Ctrl+Click</td><td>Open link</td></tr>
    </table>`, ["Close"], true);
}

// ---------- wiring ----------
document.addEventListener("keydown", e => {
  if (!$("modal").hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  const run = (fn: () => unknown) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (k === "s") run(() => saveTab(active, e.shiftKey));
  else if (k === "o") run(openDialog);
  else if (k === "n") run(() => addTab(newTab(null, null)));
  else if (k === "w") run(() => closeTab(active));
  else if (k === "tab") run(() => activate(tabs[(tabs.indexOf(active) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]));
}, true);

$("btn-new").onclick = () => addTab(newTab(null, null));
$("btn-open").onclick = openDialog;
$("btn-save").onclick = () => saveTab(active);
$("btn-about").onclick = about;
$("st-ver").onclick = about;
$<HTMLSelectElement>("theme").onchange = e => { setTheme((e.target as HTMLSelectElement).value); persistNow(); view.focus(); };

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
  window.addEventListener("focus", checkDisk);
  setInterval(checkDisk, 2000);
}

start();
