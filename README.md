# NexusMD

A fast, lightweight standalone Markdown editor (Tauri 2 + Rust + CodeMirror 6).

- **Live preview** like Obsidian: Markdown renders in place, and the raw syntax appears only on the line you're editing.
- **Never touches the file until you save** (Ctrl+S). Unsaved changes, including brand-new documents, survive closing the app, as in Notepad++.
- Unsaved state is obvious: a pulsing tab dot, a glowing editor frame, an `UNSAVED` chip, and `●` in the window title.
- Multiple documents as tabs; one window (opening another file adds a tab).
- Warns when an open file is changed or deleted by another program: reload, or keep yours and overwrite on save.
- Works on any plain-text file; `.md` files get live preview.
- Renders `$math$` / `$$math$$` (KaTeX, as MathML), ```` ```mermaid ```` diagrams, raw HTML blocks (sanitized), footnotes, `[[wikilinks]]`, and links/images/math inside tables.
- Sidebar (Ctrl+B) with the document's folder tree and an outline of its headings.
- Reorder tabs by dragging; drop a tab on the left/right half of the editor to view two documents side by side.
- Drag the line on the right edge of the text to set the page width (double-click resets it).
- Recent files list; window size and position are remembered.
- Non-UTF-8 files: pick the encoding (Windows-1252, UTF-16, …) when opening, or click the encoding in the status bar to reopen/save with another one. Mixed line endings are preserved.
- Export to HTML, or to PDF through the print dialog.
- Themes: Dystopia, Phosphor, Synthwave.

## Develop

Requires Rust and Node.js.

```powershell
npm install
npm run tauri dev
```

Tests: `npm test` (line endings) and `cd src-tauri; cargo test` (Rust).

## Release a new version

The version lives only in `package.json` (Tauri reads it from there; it's shown in the status bar and in About).

```powershell
npm version minor     # or patch / major: bumps package.json, commits, creates tag vX.Y.Z
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which builds the installers and publishes a GitHub Release:
Windows `NexusMD_X.Y.Z_x64-setup.exe`, macOS `.dmg`, Linux `.deb`/`.AppImage`.

The Windows installer is per-user (no admin rights) and registers `.md` files. To make NexusMD the default:
right-click a `.md` file → *Open with* → *Choose another app* → NexusMD → *Always*.

See [ROADMAP.md](ROADMAP.md) for planned features.
