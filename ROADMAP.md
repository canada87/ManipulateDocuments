# Roadmap

Ideas parked for later milestones. Not implemented yet.

## Markdown features
- [ ] Math formulas (LaTeX, `$...$` / `$$...$$`) — e.g. KaTeX widget
- [ ] Mermaid diagrams in ```` ```mermaid ```` blocks
- [ ] `[[wikilinks]]` between notes in the same folder
- [ ] Sidebar with folder tree
- [ ] Richer inline rendering inside tables (links, strikethrough, images)
- [ ] Raw HTML blocks rendering
- [ ] Footnotes

## Editor
- [ ] Remember window size/position
- [ ] Reorder tabs by drag & drop
- [ ] Recent files list
- [ ] Encoding choice for non UTF-8 files (today they open read-only)
- [ ] Preserve mixed line endings (today a file is saved with its dominant one)
- [ ] Outline / table of contents panel
- [ ] Export to HTML / PDF

## Distribution
- [ ] Auto-update (tauri-plugin-updater + signed releases)
- [ ] Code signing (Windows SmartScreen, macOS Gatekeeper)
- [ ] macOS: open files from Finder into the running app (`RunEvent::Opened`)
