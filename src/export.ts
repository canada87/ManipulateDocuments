// Markdown -> standalone HTML (export / print to PDF), with the same extras as the live preview.
import { Marked, type TokenizerAndRendererExtension } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";
import { KATEX, renderMermaid, wikiHref } from "./livepreview";

const math: TokenizerAndRendererExtension = {
  name: "math",
  level: "inline",
  start: src => src.indexOf("$"),
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$|^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: "math", raw: m[0], tex: m[1] ?? m[2], display: m[1] != null };
  },
  renderer: tok => katex.renderToString(tok.tex, { ...KATEX, displayMode: tok.display }),
};

const wikilinks = (md: string) =>
  md.replace(/\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g, (_m, target: string, alias?: string) => `[${alias ?? target}](<${wikiHref(target)}>)`);

// shortcut: footnotes are rewritten with regexes (one-line definitions, also matched inside code blocks); use a marked extension if that bites.
function footnotes(md: string) {
  const defs = new Map<string, string>();
  md = md.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm, (_m, k: string, v: string) => { defs.set(k, v); return ""; });
  if (!defs.size) return md;
  const order: string[] = [];
  md = md.replace(/\[\^([^\]\s]+)\]/g, (all, k: string) => {
    if (!defs.has(k)) return all;
    if (!order.includes(k)) order.push(k);
    const n = order.indexOf(k) + 1;
    return `<sup id="fnref-${n}"><a href="#fn-${n}">${n}</a></sup>`;
  });
  // blank lines around each definition let markdown render inside the <li>
  const items = order.map((k, i) => `<li id="fn-${i + 1}">\n\n${defs.get(k)} <a href="#fnref-${i + 1}">↩</a>\n\n</li>`);
  return `${md}\n\n<section class="footnotes">\n<hr>\n<ol>\n${items.join("\n")}\n</ol>\n</section>\n`;
}

const CSS = `
body { max-width: 820px; margin: 40px auto; padding: 0 24px; font: 16px/1.65 "Segoe UI", system-ui, -apple-system, sans-serif; color: #1d2330; }
h1, h2 { border-bottom: 1px solid #dde2ea; padding-bottom: .2em; }
a { color: #0b63c5; }
code, pre { font-family: "Cascadia Code", Consolas, Menlo, monospace; font-size: .9em; background: #f3f5f8; }
code { padding: 0 3px; border-radius: 3px; }
pre { padding: 12px 14px; overflow-x: auto; border: 1px solid #dde2ea; }
pre code { padding: 0; background: none; }
blockquote { margin: 0; padding-left: 14px; border-left: 3px solid #9aa6b8; color: #4a5568; }
table { border-collapse: collapse; } th, td { border: 1px solid #ccd3de; padding: 4px 12px; } th { background: #f3f5f8; }
img, svg { max-width: 100%; }
.mermaid { text-align: center; margin: 1em 0; }
.footnotes { font-size: .9em; color: #4a5568; }
@media print { body { margin: 0; max-width: none; } pre, blockquote, table, .mermaid, img { break-inside: avoid; } }
`;

const escHtml = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** `resolveImg` rewrites image sources (print needs absolute asset URLs; a saved .html keeps relative ones). */
export async function toHtml(md: string, title: string, resolveImg?: (src: string) => string): Promise<string> {
  const diagrams: string[] = [];
  const marked = new Marked({ gfm: true }, {
    extensions: [math],
    renderer: {
      code(tok) {
        if (tok.lang?.trim().toLowerCase() !== "mermaid") return false;
        diagrams.push(tok.text);
        return `<div class="mermaid" data-mermaid="${diagrams.length - 1}"></div>`;
      },
    },
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(await marked.parse(footnotes(wikilinks(md))));
  for (const el of tpl.content.querySelectorAll<HTMLElement>("[data-mermaid]")) {
    // the live preview uses the dark theme; paper wants the light one
    try { el.innerHTML = await renderMermaid(`%%{init: {"theme": "default"}}%%\n${diagrams[+el.dataset.mermaid!]}`); }
    catch (e) { el.textContent = `Mermaid error: ${e instanceof Error ? e.message : e}`; }
  }
  if (resolveImg) tpl.content.querySelectorAll("img[src]").forEach(img => img.setAttribute("src", resolveImg(img.getAttribute("src")!)));
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title><style>${CSS}</style></head>\n<body>\n${tpl.innerHTML}\n</body></html>\n`;
}

// shortcut: PDF goes through the system print dialog ("Save as PDF"); works in WebView2 (Windows), not in macOS WKWebView. Add a native PDF writer if macOS needs it.
export function printHtml(html: string) {
  const frame = Object.assign(document.createElement("iframe"), { srcdoc: html });
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.onload = () => {
    const w = frame.contentWindow!;
    w.addEventListener("afterprint", () => frame.remove());
    w.print();
  };
  document.body.append(frame);
}
