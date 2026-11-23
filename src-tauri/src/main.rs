#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    /// true when the file was not valid UTF-8: the frontend opens it read-only so a save can't corrupt it.
    lossy: bool,
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
fn read_file(path: String) -> Result<FileData, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mtime = mtime_of(Path::new(&path));
    Ok(match String::from_utf8(bytes) {
        Ok(text) => FileData { text, mtime, lossy: false },
        Err(e) => FileData {
            text: String::from_utf8_lossy(e.as_bytes()).into_owned(),
            mtime,
            lossy: true,
        },
    })
}

#[tauri::command]
fn write_file(path: String, text: String) -> Result<Option<u64>, String> {
    let p = PathBuf::from(path);
    write_atomic(&p, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(mtime_of(&p))
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            mtimes,
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
