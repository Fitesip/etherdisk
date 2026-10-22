//! Files the system sends to the app: Explorer's "Upload to Etherdisk" and "Send to"
//! start it with `--upload <paths…>` (a running app gets them from the second launch).
//! The page asks for the list, then reads each file in pieces into a File and uploads it
//! like a picked one (web/src/lib/shared-files.ts). Only listed files can be read.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// The flag that starts the list of paths.
pub const FLAG: &str = "--upload";
/// The most one read may ask for (the page reads 8 MiB at a time).
const MAX_PIECE: u64 = 64 << 20;

/// One file (or empty folder) as the page sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub size: u64,
    /// Last modified, ms since the epoch.
    pub modified: u64,
    /// Folders under the upload target, e.g. ["Photos", "2026"].
    pub dirs: Vec<String>,
    /// An empty folder: created, nothing uploaded.
    pub folder: bool,
}

#[derive(Default)]
pub struct Shared {
    next: Mutex<u64>,
    /// Sent but not yet handed to the page.
    pending: Mutex<Vec<(Item, PathBuf)>>,
    /// Handed to the page and readable until it lets them go.
    open: Mutex<HashMap<String, PathBuf>>,
}

impl Shared {
    /// Adds the paths that follow `--upload` in a command line; returns how many items.
    pub fn add_args<I: IntoIterator<Item = String>>(&self, args: I, cwd: &Path) -> usize {
        let paths: Vec<PathBuf> = args
            .into_iter()
            .skip_while(|a| a != FLAG)
            .skip(1)
            .map(|a| cwd.join(a))
            .collect();
        let mut found = Vec::new();
        for p in paths {
            collect(&p, &[], &mut found);
        }
        let mut next = self.next.lock().unwrap();
        let mut pending = self.pending.lock().unwrap();
        let n = found.len();
        for (mut item, path) in found {
            *next += 1;
            item.id = format!("s{}", *next);
            pending.push((item, path));
        }
        n
    }

    /// The items waiting for the page, now readable by id.
    pub fn take(&self) -> Vec<Item> {
        let items: Vec<_> = self.pending.lock().unwrap().drain(..).collect();
        let mut open = self.open.lock().unwrap();
        items
            .into_iter()
            .map(|(item, path)| {
                open.insert(item.id.clone(), path);
                item
            })
            .collect()
    }

    /// `len` bytes of a handed-out file from `offset` (fewer at its end).
    pub fn read(&self, id: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let path = self
            .open
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("unknown file")?;
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(len.min(MAX_PIECE) as usize);
        file.take(len.min(MAX_PIECE))
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        Ok(buf)
    }

    pub fn forget(&self, ids: &[String]) {
        let mut open = self.open.lock().unwrap();
        for id in ids {
            open.remove(id);
        }
    }
}

/// A file, or a folder with everything in it; links and unreadable entries are skipped.
fn collect(path: &Path, dirs: &[String], out: &mut Vec<(Item, PathBuf)>) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let item = |size, folder| Item {
        id: String::new(),
        name: name.clone(),
        size,
        modified,
        dirs: dirs.to_vec(),
        folder,
    };
    if meta.is_file() {
        out.push((item(meta.len(), false), path.to_owned()));
    } else if meta.is_dir() {
        let mut children: Vec<_> = fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .collect();
        children.sort();
        let before = out.len();
        let inner = [dirs, std::slice::from_ref(&name)].concat();
        for child in children {
            collect(&child, &inner, out);
        }
        if out.len() == before {
            out.push((item(0, true), path.to_owned()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        let root = std::env::temp_dir().join(format!("etherdisk-share-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Photos/2026")).unwrap();
        fs::create_dir_all(root.join("Photos/empty")).unwrap();
        fs::write(root.join("notes.txt"), b"hello world").unwrap();
        fs::write(root.join("Photos/2026/a.jpg"), b"jpeg").unwrap();
        root
    }

    #[test]
    fn files_and_folders_from_the_command_line() {
        let root = tree();
        let shared = Shared::default();
        let args = ["etherdisk.exe", "--upload", "notes.txt", "Photos"].map(String::from);
        assert_eq!(shared.add_args(args, &root), 3);
        let items = shared.take();
        let view: Vec<_> = items
            .iter()
            .map(|i| (i.dirs.join("/"), i.name.as_str(), i.size, i.folder))
            .collect();
        assert_eq!(
            view,
            [
                (String::new(), "notes.txt", 11, false),
                ("Photos/2026".to_owned(), "a.jpg", 4, false),
                ("Photos".to_owned(), "empty", 0, true),
            ]
        );
        assert!(shared.take().is_empty(), "handed out once");

        let notes = &items[0].id;
        assert_eq!(shared.read(notes, 6, 100).unwrap(), b"world");
        shared.forget(std::slice::from_ref(notes));
        assert!(shared.read(notes, 0, 5).is_err(), "let go");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nothing_without_the_flag() {
        let shared = Shared::default();
        assert_eq!(
            shared.add_args(["etherdisk.exe".to_owned()], Path::new(".")),
            0
        );
        assert_eq!(
            shared.add_args(
                ["etherdisk.exe", "--upload", "does-not-exist"].map(String::from),
                Path::new(".")
            ),
            0
        );
    }
}
