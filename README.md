# NexusMD

A fast, lightweight standalone Markdown editor (Tauri 2 + Rust + CodeMirror 6).

- **Live preview** like Obsidian: Markdown renders in place, and the raw syntax appears only on the line you're editing.
- **Never touches the file until you save** (Ctrl+S). Unsaved changes, including brand-new documents, survive closing the app, as in Notepad++.
- Unsaved state is obvious: a pulsing tab dot, a glowing editor frame, an `UNSAVED` chip, and `●` in the window title.
- Multiple documents as tabs; one window (opening another file adds a tab).
- Warns when an open file is changed or deleted by another program: reload, or keep yours and overwrite on save.
- Works on any plain-text file; `.md` files get live preview.
- Themes: Dystopia, Phosphor, Synthwave.

## Develop

Requires Rust and Node.js.

```powershell
npm install
npm run tauri dev
```

Rust tests: `cd src-tauri; cargo test`

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
