#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
struct FileData {
    text: String,
    mtime: Option<u64>,
    /// true when the bytes didn't decode cleanly: the frontend asks for another encoding or opens it read-only.
    lossy: bool,
    /// WHATWG name of the encoding used (e.g. "UTF-8", "windows-1252", "UTF-16LE").
    encoding: &'static str,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    dir: bool,
}

fn encoding_for(label: &str) -> Result<&'static Encoding, String> {
    Encoding::for_label(label.as_bytes()).ok_or_else(|| format!("Unknown encoding: {label}"))
}

/// Decode with `label`, or sniff a BOM and fall back to UTF-8. The BOM stays in the text
/// (the frontend strips it and puts it back on save).
fn decode(bytes: &[u8], label: Option<&str>) -> Result<(String, &'static Encoding, bool), String> {
    let enc = match label {
        Some(l) => encoding_for(l)?,
        None => Encoding::for_bom(bytes).map_or(UTF_8, |(e, _)| e),
    };
    let (text, lossy) = enc.decode_without_bom_handling(bytes);
    Ok((text.into_owned(), enc, lossy))
}

fn encode(text: &str, label: &str) -> Result<Vec<u8>, String> {
    let enc = encoding_for(label)?;
    // encoding_rs only encodes UTF-16 as UTF-8 (WHATWG rule), so do it by hand.
    if enc == UTF_16LE {
        return Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect());
    }
    if enc == UTF_16BE {
        return Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect());
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(format!("Some characters can't be saved as {}. Change the encoding to UTF-8.", enc.name()));
    }
    Ok(bytes.into_owned())
}

fn mtime_of(p: &Path) -> Option<u64> {
    let d = fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(d.as_millis() as u64)
}

/// Write to a sibling temp file, then rename over the target: the original is never left half-written.
fn write_atomic(p: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut tmp = p.as_os_str().to_owned();
    tmp.push(".nexusmd-tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, p).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Existing files among CLI args (first arg is the exe), resolved against `cwd`.
fn file_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| cwd.join(a))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
fn read_file(path: String, encoding: Option<String>) -> Result<FileData, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (text, enc, lossy) = decode(&bytes, encoding.as_deref())?;
    Ok(FileData { text, mtime: mtime_of(Path::new(&path)), lossy, encoding: enc.name() })
}

#[tauri::command]
fn write_file(path: String, text: String, encoding: Option<String>) -> Result<Option<u64>, String> {
    let p = PathBuf::from(path);
    let bytes = encode(&text, encoding.as_deref().unwrap_or("UTF-8"))?;
    write_atomic(&p, &bytes).map_err(|e| e.to_string())?;
    Ok(mtime_of(&p))
}

/// Folder listing for the sidebar: sub-folders first, then files, by name; hidden entries skipped.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .filter(|e| !e.name.starts_with('.'))
        .collect();
    out.sort_by_key(|e| (!e.dir, e.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn mtimes(paths: Vec<String>) -> Vec<Option<u64>> {
    paths.iter().map(|p| mtime_of(Path::new(p))).collect()
}

#[tauri::command]
fn launch_files() -> Vec<String> {
    file_args(std::env::args(), &std::env::current_dir().unwrap_or_default())
}

fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(session_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, data: String) -> Result<(), String> {
    write_atomic(&session_path(&app)?, data.as_bytes()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch forwards its files to this window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let _ = app.emit("open-files", file_args(args, Path::new(&cwd)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            mtimes,
            list_dir,
            launch_files,
            load_session,
            save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running NexusMD");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = std::env::temp_dir().join("nexusmd-test");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.md");
        fs::write(&f, "old").unwrap();
        write_atomic(&f, b"new").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "new");
        assert!(!dir.join("a.md.nexusmd-tmp").exists());
    }

    #[test]
    fn encodings_round_trip() {
        // windows-1252: "è" is one byte
        let (t, e, lossy) = decode(b"caff\xe8", Some("windows-1252")).unwrap();
        assert_eq!((t.as_str(), e.name(), lossy), ("caffè", "windows-1252", false));
        assert_eq!(encode("caffè", "windows-1252").unwrap(), b"caff\xe8");
        // invalid UTF-8 is flagged; BOM-sniffed UTF-16 keeps its BOM char for the frontend
        assert!(decode(b"caff\xe8", None).unwrap().2);
        let (t, e, _) = decode(b"\xff\xfea\x00", None).unwrap();
        assert_eq!((t.as_str(), e.name()), ("\u{feff}a", "UTF-16LE"));
        assert_eq!(encode("\u{feff}a", "UTF-16LE").unwrap(), b"\xff\xfea\x00");
        // characters the target can't hold are an error, never silently replaced
        assert!(encode("\u{4e2d}", "windows-1252").is_err());
    }

    #[test]
    fn list_dir_sorts_dirs_first_and_skips_hidden() {
        let dir = std::env::temp_dir().join("nexusmd-test-list");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("zsub")).unwrap();
        fs::write(dir.join("a.md"), "").unwrap();
        fs::write(dir.join(".hidden"), "").unwrap();
        let got: Vec<_> = list_dir(dir.to_string_lossy().into_owned()).unwrap().into_iter().map(|e| (e.name, e.dir)).collect();
        assert_eq!(got, vec![("zsub".into(), true), ("a.md".into(), false)]);
    }

    #[test]
    fn file_args_skips_exe_flags_and_missing() {
        let dir = std::env::temp_dir().join("nexusmd-test-args");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.md"), "").unwrap();
        let got = file_args(
            ["exe", "--flag", "x.md", "missing.md"].map(String::from),
            &dir,
        );
        assert_eq!(got, vec![dir.join("x.md").to_string_lossy().into_owned()]);
    }
}
