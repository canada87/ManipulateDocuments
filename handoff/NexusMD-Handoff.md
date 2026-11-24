---
title: NexusMD — handoff
last_updated: 2026-11-24
---

## Quando usarlo
Riapre lo sviluppo di NexusMD, l'editor Markdown standalone (Tauri 2 + CodeMirror 6).
La v0.1.0 e la v0.2.0 (14 voci della roadmap) sono rilasciate su GitHub. La v0.2.0 non è stata
collaudata a mano nell'app vera: si riparte da quel collaudo e dai fix (che andranno in una v0.2.x).

## Il prompt

```text
## Dove sono le cose
- Repo: C:\Users\ajaca\OneDrive\ponte\programmi\python\vargroup\repository\PersonalProjects\ManipulateDocuments
  (remote https://github.com/canada87/ManipulateDocuments, branch main)
- Cosa fa l'app e come si rilascia: README.md. Feature rimandate: ROADMAP.md. Leggili entrambi.
- Frontend: src/main.ts (tab + riordino a trascinamento, salvataggio, encoding, sessione, watcher disco,
  sidebar cartella/outline, recenti, export, modali, About), src/livepreview.ts (live preview stile Obsidian,
  estensioni del parser: $math$, [[wikilink]], [^footnote]; widget a blocco in uno StateField: tabelle,
  $$math$$ multi-riga, mermaid, HTML), src/eol.ts (line ending misti, puro), src/export.ts (marked -> HTML,
  stampa PDF), src/style.css (layout + 3 temi come variabili CSS), index.html
- Backend Rust: src-tauri/src/main.rs (comandi read_file/write_file con encoding opzionale, mtimes,
  list_dir, launch_files, load_session, save_session; plugin window-state; 5 unit test),
  src-tauri/tauri.conf.json, src-tauri/capabilities/default.json
- Test: `npm test` (tests/eol.test.mjs, Node esegue il .ts da solo) e `cd src-tauri; cargo test`
- CI release: .github/workflows/release.yml (parte su push di tag v*)
- Ambiente: Rust 1.98, Node 24, npm, PowerShell/Git Bash su Windows 11. gh CLI NON installato.
- Comandi: `npm run tauri dev` (app vera), `npm run tauri build -- --bundles nsis` (installer locale in
  src-tauri/target/release/bundle/nsis/), `cd src-tauri; cargo test`, `npx tsc -p .` (typecheck)
- Anteprima solo frontend nel browser pane: .claude/launch.json, config "vite" (porta 1420).
  Lì le chiamate invoke() falliscono (niente file), ma rendering e temi si vedono.
- Non toccare: identifier "com.canada87.nexusmd" in tauri.conf.json (cambiarlo sposta la cartella
  della sessione in %APPDATA% e fa perdere le modifiche non salvate degli utenti).
  .claude/ è config locale: sta in .gitignore, non committarla. handoff/ invece è versionata.

## Cosa è già stabilito — non riscoprirlo, non contraddirlo
- Scelte dell'utente: Tauri + CodeMirror 6; live preview (sintassi visibile solo sulla riga del cursore);
  modifiche non salvate e documenti mai salvati sopravvivono alla chiusura come in Notepad++ (chiudere la
  finestra non chiede nulla, chiudere una tab sporca sì); doppio clic su un altro .md = nuova tab nella
  stessa finestra; file cambiato fuori = banner Ricarica / Ignora (Ignora tiene il mio e sovrascrive al
  salvataggio); tema Blade Runner ("Dystopia") + Phosphor + Synthwave; principalmente Windows ma build
  multipiattaforma; ogni milestone = tag git + release con installer; versione visibile nell'app.
- v0.1.0 rilasciata: GitHub Actions Release run #1 riuscita in 6m0s, 5 asset pubblicati
  (NexusMD_0.1.0_x64-setup.exe, _aarch64.dmg, _aarch64.app.tar.gz, _amd64.deb, _amd64.AppImage).
  Build locale: nexusmd.exe 4,0 MB, installer NSIS 1,71 MB (per-utente, senza admin, associa .md).
- v0.2.0 rilasciata 2026-11-25: Release run #2 riuscita, 5 asset (NexusMD_0.2.0_x64-setup.exe 3,4 MB,
  _aarch64.dmg, _amd64.deb, _amd64.AppImage, NexusMD_aarch64.app.tar.gz).
- La versione vive SOLO in package.json (tauri.conf.json ha "version": "../package.json"; il workflow
  fallisce se il tag non coincide). Rilascio: `npm version minor` poi `git push --follow-tags`.
  La versione in src-tauri/Cargo.toml non viene usata.
- v0.1.0 verificato: cargo test, tsc, nel browser pane la live preview di base (titoli, enfasi, codice,
  link, checkbox, elenchi, citazioni, hr, tabelle, blocchi di codice) e i 3 temi.
- v0.2.0, scelte dell'utente (2026-11-24): tutte le voci Markdown ed Editor di ROADMAP.md, più encoding ed
  EOL misti. Fuori: auto-update, code signing, macOS RunEvent::Opened (restano in ROADMAP.md).
- v0.2.0, come è fatta: KaTeX con output "mathml" (niente font/CSS da distribuire); mermaid importato
  dinamicamente al primo diagramma (chunk separato), tema dark nell'editor e "default" nell'export;
  HTML grezzo passato da DOMPurify (il documento non è fidato: l'app espone l'API Tauri); export con
  marked + estensione $math$ + wikilink/footnote riscritti a regex; PDF = iframe nascosto + print().
  Encoding: Rust con encoding_rs, BOM sniffing, errore (non sostituzione) se un carattere non è
  rappresentabile; Esc sul dialogo "Not UTF-8" annulla l'apertura. EOL: break dominante + StateField
  di marker (MapMode.TrackAfter) per quelli diversi. Recenti (12) e stato sidebar stanno in session.json.
  Finestra: tauri-plugin-window-state, solo lato Rust. Sidebar: solo cartelle + file markdown, niente nascosti.
- v0.2.0 verificato: cargo test 5/5, npm test 3/3, tsc pulito; nel browser pane: math inline/blocco,
  "$5 and $6" resta testo, wikilink con alias, footnote (Ctrl+clic rimbalza ref<->definizione), tabella
  con grassetto/barrato/link/math/wikilink, HTML con onerror rimosso, mermaid renderizzato, outline
  cliccabile, drag delle tab, toHtml (MathML, SVG, footnote, wikilink); marker EOL seguono le modifiche
  (scrittura a fine riga, riga sopra, cancellazione del break). Build locale NSIS ok: nexusmd.exe 5,5 MB,
  installer 3,24 MB (si chiama ancora _0.1.0_ finché non si fa npm version; mermaid è in chunk separati).
- NON verificato a mano nell'app vera (v0.1.0 e v0.2.0): salvataggio/Salva con nome, banner file
  cambiato/cancellato, ripristino sessione, istanza singola, drag&drop file, apertura da Esplora file,
  Ctrl+N/W/B dentro WebView2, mermaid sotto la CSP di Tauri, print() in WebView2, posizione finestra
  ricordata, dialoghi encoding su file veri (cp1252, UTF-16), albero cartelle su disco vero, RECENT, export HTML su disco.
- Architettura: un solo EditorView, ogni tab ha il suo EditorState (setState allo switch). Testo
  normalizzato a \n; EOL (CRLF/LF) e BOM ricordati per tab e ripristinati al salvataggio. File non UTF-8
  aperti in sola lettura. Scrittura atomica: file .nexusmd-tmp accanto + rename. Sessione in
  %APPDATA%\com.canada87.nexusmd\session.json, salvata 800 ms dopo ogni modifica e alla chiusura.
  Watcher: confronto mtime ogni 2 s e al focus (niente crate notify). Link: Ctrl+clic.
- Scorciatoie note già marcate nel codice con commenti `shortcut:` (celle tabella con inline minimo,
  confronto path case-insensitive, sessione come unico JSON).

Risultati negativi / trappole:
- Accesso all'EditorView da JS nel browser pane: `.cm-content`.cmView non esiste in questa versione di
  CM; si risale da `.cm-content`.cmTile via .parent fino a trovare .view.
- `git push` del tag da qui ha superato i 120 s (è andato a buon fine): lanciare i push in background.
- Decorazioni block non possono stare nel ViewPlugin: stanno in uno StateField (blockField);
  blocchi dentro citazioni/elenchi restano raw apposta (il widget deve coprire righe intere).
- Browser pane nascosto: requestAnimationFrame non scatta e javascript_tool va in timeout -> niente rAF
  negli script di prova. Script Python con backslash in heredoc bash si rompono: scriverli nello scratchpad.
- `node --test tests/` fallisce su Node 24: serve il glob (`tests/*.test.mjs`, già nello script npm).
- Drag & drop HTML5 nella WebView è preso dal drop dei file di Tauri: il riordino tab usa pointer events.
- encoding_rs "codifica" UTF-16 come UTF-8 (regola WHATWG): UTF-16 è scritto a mano in encode().

## Cosa voglio adesso
1. L'utente collauda la v0.2.0 con `npm run tauri dev` (lista "NON verificato" qui sopra; RECENT è il menu
   a tendina dei file recenti nella barra in alto) e scrive in chat cosa non va; correggere, un commit per fix.
   Su un clone nuovo serve `npm install`.
2. Su OK esplicito dell'utente in chat: `npm version patch` (→ 0.2.1 + commit + tag), `git push --follow-tags`
   in background. Senza gh: stato run dall'API pubblica
   https://api.github.com/repos/canada87/ManipulateDocuments/actions/runs?per_page=1 (curl, campi status e
   conclusion) e asset da https://api.github.com/repos/canada87/ManipulateDocuments/releases/tags/v0.2.1.


## Regole
- Push di tag = pubblicazione di una release: solo con OK esplicito dell'utente.
- Codice, commenti e README in inglese; con l'utente si parla italiano.
- Soluzione minima che funziona, niente dipendenze per poche righe; ogni scorciatoia con limite noto
  ha un commento `shortcut: <limite>, <quando migliorarla>`.
```
