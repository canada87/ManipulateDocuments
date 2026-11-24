# Roadmap

Ideas for later milestones. Checked items shipped in v0.2.0.

## Markdown features
- [x] Math formulas (LaTeX, `$...$` / `$$...$$`) — e.g. KaTeX widget
- [x] Mermaid diagrams in ```` ```mermaid ```` blocks
- [x] `[[wikilinks]]` between notes in the same folder
- [x] Sidebar with folder tree
- [x] Richer inline rendering inside tables (links, strikethrough, images)
- [x] Raw HTML blocks rendering
- [x] Footnotes

## Editor
- [x] Remember window size/position
- [x] Reorder tabs by drag & drop
- [x] Recent files list
- [x] Encoding choice for non UTF-8 files (today they open read-only)
- [x] Preserve mixed line endings (today a file is saved with its dominant one)
- [x] Outline / table of contents panel
- [x] Export to HTML / PDF

## Distribution
- [ ] Auto-update (tauri-plugin-updater + signed releases)
- [ ] Code signing (Windows SmartScreen, macOS Gatekeeper)
- [ ] macOS: open files from Finder into the running app (`RunEvent::Opened`)
