//! Where the app keeps its data: an "Etherdisk" folder (`%APPDATA%\Etherdisk` on Windows,
//! `~/Library/Application Support/Etherdisk` on macOS, `~/.local/share/Etherdisk` on Linux)
//! instead of folders named after the bundle identifier. The webview's profile (sign-in,
//! settings) and the window's size and position live there. Data an earlier version left
//! in the identifier's folders moves in on the first start.

use std::fs;
use std::path::{Path, PathBuf};

/// The folder's name under the system's data directory.
pub const NAME: &str = "Etherdisk";

/// The app's data folder.
pub fn app_dir() -> Option<PathBuf> {
    Some(::dirs::data_dir()?.join(NAME))
}

/// Moves what earlier versions kept in the identifier's folders into the app's data folder,
/// unless that folder already exists.
pub fn move_old_data(identifier: &str) {
    let Some(new) = app_dir() else { return };
    let old: Vec<PathBuf> = [
        ::dirs::data_local_dir(),
        ::dirs::config_dir(),
        ::dirs::data_dir(),
    ]
    .into_iter()
    .flatten()
    .map(|d| d.join(identifier))
    .collect();
    if let Err(e) = move_into(&new, &old) {
        eprintln!("Etherdisk: moving the data of an earlier version: {e}");
    }
}

/// Moves the entries of each folder in `old` (in order; an entry already moved stays as it
/// is) into `new` and removes the emptied folders. Does nothing once `new` exists.
fn move_into(new: &Path, old: &[PathBuf]) -> std::io::Result<()> {
    if new.exists() {
        return Ok(());
    }
    let mut created = false;
    for dir in old {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        if !created {
            fs::create_dir_all(new)?;
            created = true;
        }
        for entry in entries.flatten() {
            let to = new.join(entry.file_name());
            if !to.exists() {
                fs::rename(entry.path(), to)?;
            }
        }
        let _ = fs::remove_dir(dir);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_of_an_earlier_version_moves_once() {
        let root = std::env::temp_dir().join(format!("etherdisk-dirs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (local, roaming, new) = (
            root.join("local/app.x"),
            root.join("roaming/app.x"),
            root.join("roaming/Etherdisk"),
        );
        fs::create_dir_all(local.join("EBWebView/Default")).unwrap();
        fs::write(local.join("EBWebView/Default/Prefs"), b"signed in").unwrap();
        fs::create_dir_all(&roaming).unwrap();
        fs::write(roaming.join(".window-state.json"), b"{}").unwrap();

        // The same folder may come up twice (config and data are one on Windows).
        move_into(&new, &[local.clone(), roaming.clone(), roaming.clone()]).unwrap();
        assert_eq!(
            fs::read(new.join("EBWebView/Default/Prefs")).unwrap(),
            b"signed in"
        );
        assert!(new.join(".window-state.json").exists());
        assert!(!local.exists() && !roaming.exists(), "old folders removed");

        // Later starts leave things alone, even if an old folder shows up again.
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("stray"), b"").unwrap();
        move_into(&new, std::slice::from_ref(&local)).unwrap();
        assert!(local.join("stray").exists());
        assert!(!new.join("stray").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nothing_to_move_creates_nothing() {
        let root = std::env::temp_dir().join(format!("etherdisk-dirs-none-{}", std::process::id()));
        let new = root.join("Etherdisk");
        move_into(&new, &[root.join("missing")]).unwrap();
        assert!(!new.exists());
    }
}
