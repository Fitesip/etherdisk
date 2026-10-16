//! Several storage directories ("volumes", e.g. one per RAID array). Each vault lives
//! entirely on one volume, recorded in `vault_volumes`; a new vault goes to the volume
//! with the most free space. Every directory holds a marker file with its volume id, so
//! a vault stays tied to its volume when paths or their order change in the config. A
//! volume that is configured away (or not mounted) makes its vaults fail with an error
//! instead of silently starting over on another volume.
//!
//! Each vault holds its unused capacity as real disk space: a preallocated `.reserve` file
//! in its folder, sized to "capacity minus what the vault stores", that shrinks before
//! uploads and grows back after deletions. Writes to a vault therefore never find the
//! disk full, and a volume's free space is what no drive has been promised yet. A
//! volume's last `KEEP_FREE_PERCENT` is never reserved (the system and the database may
//! share the disk); what doesn't fit is reported as a shortage. A vault that is short moves
//! to another volume as soon as one has room for its whole capacity (e.g. a new array):
//! its writes wait while its folder is copied, reads keep using the old copy until the switch.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use sqlx::SqlitePool;

use crate::now;
use crate::storage::{AppendError, BlobStore, ByteStream, LocalStore};

const MARKER: &str = ".etherdisk-volume";
/// The file in a vault's folder that holds its reserved space.
const RESERVE: &str = ".reserve";
/// Reservations never take a volume below this share of free space (by default).
pub const KEEP_FREE_PERCENT: u64 = 5;

struct Volume {
    id: String,
    root: PathBuf,
    store: LocalStore,
}

/// Free space of one volume, for logs and monitoring.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VolumeInfo {
    pub id: String,
    pub root: PathBuf,
    pub total_bytes: u64,
    /// Free space: not used by files and not reserved for drives.
    pub available_bytes: u64,
    /// Space held for drives' unused capacity (their `.reserve` files).
    pub reserved_bytes: u64,
    pub vaults: i64,
}

/// Opens a storage directory. One without a marker becomes a new volume; vault folders
/// already in it (data written before volumes existed) are returned to be registered.
fn open_volume(root: &Path) -> io::Result<(Volume, Vec<String>)> {
    std::fs::create_dir_all(root)?;
    let marker = root.join(MARKER);
    let (id, adopted) = match std::fs::read_to_string(&marker) {
        Ok(id) if !id.trim().is_empty() => (id.trim().to_owned(), Vec::new()),
        Ok(_) => return Err(io::Error::other(format!("{} is empty", marker.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let id = uuid::Uuid::new_v4().to_string();
            let mut existing = Vec::new();
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type()?.is_dir() && !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) {
                    existing.push(name);
                }
            }
            std::fs::write(&marker, &id)?;
            (id, existing)
        }
        Err(e) => return Err(e),
    };
    Ok((Volume { id, root: root.to_owned(), store: LocalStore::new(root)? }, adopted))
}

fn db_err(e: sqlx::Error) -> io::Error {
    io::Error::other(e)
}

/// Keys look like `{token_id}/...`: the vault decides the volume.
fn token_of(key: &str) -> &str {
    key.split('/').next().unwrap_or(key)
}

pub struct VolumeStore {
    volumes: Vec<Volume>,
    db: SqlitePool,
    /// token id -> index into `volumes`
    placed: Mutex<HashMap<String, usize>>,
    /// token id -> bytes of its capacity not backed by disk space (only vaults that are short)
    short: Mutex<HashMap<String, u64>>,
    /// Share of each volume (percent) that reservations leave free.
    keep_free_percent: u64,
    /// Vaults being moved to another volume, and writes in flight per vault: a move waits
    /// for the writes, new writes wait for the move.
    moves: Mutex<Moves>,
}

/// A write in flight (see `VolumeStore::begin_write`).
struct WriteGuard<'a> {
    store: &'a VolumeStore,
    token: String,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        let mut m = self.store.moves.lock().unwrap();
        if let Some(n) = m.writing.get_mut(&self.token) {
            *n -= 1;
            if *n == 0 {
                m.writing.remove(&self.token);
            }
        }
    }
}

#[derive(Default)]
struct Moves {
    moving: HashSet<String>,
    writing: HashMap<String, usize>,
}

/// How long a move waits for a vault's writes in flight, and writes wait for a move.
const MOVE_WAIT: std::time::Duration = std::time::Duration::from_secs(600);

/// Copies a vault's folder (without its reservation) into `to`, built next to it under a
/// temporary name and renamed into place at the end.
fn copy_vault(from: &Path, to: &Path) -> io::Result<()> {
    fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name();
            if name == RESERVE {
                continue;
            }
            if entry.file_type()?.is_dir() {
                copy_dir(&entry.path(), &to.join(&name))?;
            } else {
                std::fs::copy(entry.path(), to.join(&name))?;
            }
        }
        Ok(())
    }
    let tmp = to.with_extension("moving");
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_dir_all(to);
    if from.exists() {
        copy_dir(from, &tmp)?;
    } else {
        std::fs::create_dir_all(&tmp)?;
    }
    // Flush the folder on Linux (Windows can't open a folder as a file; nothing to do there).
    if let Ok(dir) = std::fs::File::open(&tmp) {
        let _ = dir.sync_all();
    }
    std::fs::rename(&tmp, to)
}

/// Sizes a vault's reservation file. "Backed" is the part of the capacity the vault can
/// actually use: what it stores plus its reservation. It never shrinks, and grows (up to the
/// capacity) only with free space above the kept-free share, so a vault that didn't fit
/// takes its uploads out of its own reservation instead of the volume's last free space.
/// `backed` is the previous value, or `None` (new vault, or after a restart: then what's on
/// disk). Returns the new backed size.
fn resize_reserve(root: &Path, path: &Path, capacity: u64, used: u64, backed: Option<u64>, keep_free_percent: u64) -> io::Result<u64> {
    use fs4::FileExt;
    std::fs::create_dir_all(path.parent().expect("a vault folder"))?;
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path)?;
    let have = file.metadata()?.len();
    let backed = backed.unwrap_or(used + have).min(capacity);
    let floor = fs4::total_space(root)? * keep_free_percent / 100;
    let room = fs4::available_space(root)?.saturating_sub(floor);
    let target = capacity.saturating_sub(used).min(backed.saturating_sub(used) + room).min(have + room);
    if target < have {
        file.set_len(target)?;
    } else if target > have {
        FileExt::allocate(&file, target)?;
    }
    Ok((used + target).min(capacity))
}

/// Size of a vault's reservation (0 if it has none).
fn reserve_len(root: &Path, token: &str) -> u64 {
    std::fs::metadata(root.join(token).join(RESERVE)).map_or(0, |m| m.len())
}

/// Differences in free space smaller than this don't decide where a new vault goes.
const FREE_SPACE_TIE: u64 = 1 << 30;

impl VolumeStore {
    pub async fn open(dirs: &[PathBuf], db: SqlitePool) -> anyhow::Result<Self> {
        anyhow::ensure!(!dirs.is_empty(), "DATA_DIR is empty");
        let mut volumes: Vec<Volume> = Vec::new();
        for dir in dirs {
            let (volume, adopted) = open_volume(dir)?;
            if let Some(other) = volumes.iter().find(|v| v.id == volume.id) {
                anyhow::bail!("{} and {} are the same volume ({})", other.root.display(), dir.display(), volume.id);
            }
            for token in adopted {
                sqlx::query("INSERT OR IGNORE INTO vault_volumes (token_id, volume, created_at) VALUES (?, ?, ?)")
                    .bind(&token)
                    .bind(&volume.id)
                    .bind(now())
                    .execute(&db)
                    .await?;
            }
            volumes.push(volume);
        }
        let store = Self {
            volumes,
            db,
            placed: Mutex::new(HashMap::new()),
            short: Mutex::new(HashMap::new()),
            keep_free_percent: KEEP_FREE_PERCENT,
            moves: Mutex::default(),
        };
        for (id, vaults) in store.missing().await? {
            tracing::error!(volume = %id, vaults, "storage volume is not configured or not mounted: its drives are unavailable");
        }
        Ok(store)
    }

    /// Every configured volume with its free space and number of vaults.
    pub async fn info(&self) -> io::Result<Vec<VolumeInfo>> {
        let mut out = Vec::with_capacity(self.volumes.len());
        for v in &self.volumes {
            let tokens: Vec<String> = sqlx::query_scalar("SELECT token_id FROM vault_volumes WHERE volume = ?")
                .bind(&v.id)
                .fetch_all(&self.db)
                .await
                .map_err(db_err)?;
            out.push(VolumeInfo {
                id: v.id.clone(),
                root: v.root.clone(),
                total_bytes: fs4::total_space(&v.root)?,
                available_bytes: fs4::available_space(&v.root)?,
                reserved_bytes: tokens.iter().map(|t| reserve_len(&v.root, t)).sum(),
                vaults: tokens.len() as i64,
            });
        }
        Ok(out)
    }

    /// Volumes that hold drives but are not configured (or not mounted): (id, drives).
    pub async fn missing(&self) -> io::Result<Vec<(String, i64)>> {
        let known: Vec<(String, i64)> = sqlx::query_as("SELECT volume, COUNT(*) FROM vault_volumes GROUP BY volume")
            .fetch_all(&self.db)
            .await
            .map_err(db_err)?;
        Ok(known.into_iter().filter(|(id, _)| !self.volumes.iter().any(|v| &v.id == id)).collect())
    }

    /// The vault's volume, if it has one yet.
    async fn find(&self, token: &str) -> io::Result<Option<&Volume>> {
        if let Some(&i) = self.placed.lock().unwrap().get(token) {
            return Ok(Some(&self.volumes[i]));
        }
        let id: Option<String> = sqlx::query_scalar("SELECT volume FROM vault_volumes WHERE token_id = ?")
            .bind(token)
            .fetch_optional(&self.db)
            .await
            .map_err(db_err)?;
        let Some(id) = id else { return Ok(None) };
        let i = self
            .volumes
            .iter()
            .position(|v| v.id == id)
            .ok_or_else(|| io::Error::other(format!("storage volume {id} of drive {token} is not available")))?;
        self.placed.lock().unwrap().insert(token.to_owned(), i);
        Ok(Some(&self.volumes[i]))
    }

    /// Another share of each volume to keep free (tests on a nearly full disk use 0).
    pub fn keep_free(mut self, percent: u64) -> Self {
        self.keep_free_percent = percent;
        self
    }

    /// Starts a write of the vault: waits out a move of it, and keeps a move from starting
    /// until the returned guard is dropped.
    async fn begin_write(&self, token: &str) -> io::Result<WriteGuard<'_>> {
        let start = std::time::Instant::now();
        loop {
            {
                let mut m = self.moves.lock().unwrap();
                if !m.moving.contains(token) {
                    *m.writing.entry(token.to_owned()).or_default() += 1;
                    return Ok(WriteGuard { store: self, token: token.to_owned() });
                }
            }
            if start.elapsed() > MOVE_WAIT {
                return Err(io::Error::other(format!("drive {token} is being moved to another volume")));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// Moves a vault to another volume with room for its whole `capacity` (above that volume's
    /// kept-free share). Returns whether it moved; `false` when no other volume has room.
    pub async fn relocate(&self, token: &str, capacity: u64) -> io::Result<bool> {
        let Some(from) = self.find(token).await? else { return Ok(false) };
        let infos = self.info().await?;
        let target = infos
            .iter()
            .filter(|i| i.id != from.id && i.available_bytes.saturating_sub(i.total_bytes * self.keep_free_percent / 100) >= capacity)
            .max_by_key(|i| i.available_bytes);
        let Some(target) = target else { return Ok(false) };
        let to = self.volumes.iter().find(|v| v.id == target.id).expect("info lists configured volumes");

        // No new writes; wait for the ones in flight.
        if !self.moves.lock().unwrap().moving.insert(token.to_owned()) {
            return Ok(false);
        }
        let start = std::time::Instant::now();
        while self.moves.lock().unwrap().writing.contains_key(token) {
            if start.elapsed() > MOVE_WAIT {
                self.moves.lock().unwrap().moving.remove(token);
                return Err(io::Error::other(format!("drive {token} kept writing: not moved")));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let (src, dst) = (from.root.join(token), to.root.join(token));
        let copied = {
            let (src, dst) = (src.clone(), dst.clone());
            tokio::task::spawn_blocking(move || copy_vault(&src, &dst)).await.map_err(io::Error::other).and_then(|r| r)
        };
        let switched = match copied {
            Ok(()) => sqlx::query("UPDATE vault_volumes SET volume = ? WHERE token_id = ?")
                .bind(&to.id)
                .bind(token)
                .execute(&self.db)
                .await
                .map_err(db_err),
            Err(e) => Err(e),
        };
        if let Err(e) = switched {
            self.moves.lock().unwrap().moving.remove(token);
            let dst = dst.clone();
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dst)).await;
            return Err(e);
        }
        let to_index = self.volumes.iter().position(|v| v.id == to.id).expect("configured");
        self.placed.lock().unwrap().insert(token.to_owned(), to_index);
        self.short.lock().unwrap().remove(token);
        self.moves.lock().unwrap().moving.remove(token);
        tracing::info!(%token, from = %from.root.display(), to = %to.root.display(), "storage: drive moved to a volume with room for its capacity");
        // The old copy goes last: a download that started before the switch keeps reading it.
        if let Err(e) = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(src)).await.map_err(io::Error::other).and_then(|r| r) {
            tracing::warn!(%token, "storage: removing the moved drive's old copy: {e}");
        }
        Ok(true)
    }

    /// Drives whose capacity isn't fully backed by disk space: (token id, missing bytes).
    pub fn shortages(&self) -> Vec<(String, u64)> {
        let mut out: Vec<_> = self.short.lock().unwrap().iter().map(|(t, b)| (t.clone(), *b)).collect();
        out.sort();
        out
    }

    /// The vault's volume; a new vault goes where the most space is free, among the volumes
    /// where `need` bytes fit above their kept-free share (any volume if none has room).
    /// Free space within `FREE_SPACE_TIE` counts as equal (volumes on one disk, or a disk
    /// others keep writing to, never read exactly the same): then the fewest vaults win.
    async fn place(&self, token: &str, need: u64) -> io::Result<&Volume> {
        if let Some(v) = self.find(token).await? {
            return Ok(v);
        }
        let infos = self.info().await?;
        let fits = |i: &VolumeInfo| i.available_bytes.saturating_sub(i.total_bytes * self.keep_free_percent / 100) >= need;
        let any_fits = infos.iter().any(fits);
        let mut best: Option<(u64, i64, &Volume)> = None;
        for info in infos.iter().filter(|i| !any_fits || fits(i)) {
            let v = self.volumes.iter().find(|v| v.id == info.id).expect("info lists configured volumes");
            let better = match best {
                None => true,
                Some((free, vaults, _)) => {
                    if info.available_bytes.abs_diff(free) < FREE_SPACE_TIE {
                        info.vaults < vaults
                    } else {
                        info.available_bytes > free
                    }
                }
            };
            if better {
                best = Some((info.available_bytes, info.vaults, v));
            }
        }
        let (_, _, chosen) = best.expect("at least one volume");
        // Two first writes may race: the first insert wins, both use its volume.
        sqlx::query("INSERT OR IGNORE INTO vault_volumes (token_id, volume, created_at) VALUES (?, ?, ?)")
            .bind(token)
            .bind(&chosen.id)
            .bind(now())
            .execute(&self.db)
            .await
            .map_err(db_err)?;
        self.find(token).await?.ok_or_else(|| io::Error::other("volume placement was lost"))
    }
}

#[async_trait]
impl BlobStore for VolumeStore {
    async fn size(&self, key: &str) -> io::Result<Option<u64>> {
        match self.find(token_of(key)).await? {
            Some(v) => v.store.size(key).await,
            None => Ok(None),
        }
    }

    async fn append(&self, key: &str, body: ByteStream, max: u64) -> Result<u64, AppendError> {
        let _write = self.begin_write(token_of(key)).await?;
        self.place(token_of(key), 0).await?.store.append(key, body, max).await
    }

    async fn put(&self, key: &str, data: Bytes) -> io::Result<()> {
        let _write = self.begin_write(token_of(key)).await?;
        self.place(token_of(key), 0).await?.store.put(key, data).await
    }

    async fn read_range(&self, key: &str, offset: u64, len: u64) -> io::Result<ByteStream> {
        match self.find(token_of(key)).await? {
            Some(v) => v.store.read_range(key, offset, len).await,
            None => Err(io::ErrorKind::NotFound.into()),
        }
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
        let _write = self.begin_write(token_of(key)).await?;
        match self.find(token_of(key)).await? {
            Some(v) => v.store.delete(key).await,
            None => Ok(()),
        }
    }

    /// Frees the vault's place too: after a format it may land on another volume.
    async fn delete_vault(&self, token_id: &str) -> io::Result<()> {
        if let Some(v) = self.find(token_id).await? {
            v.store.delete_vault(token_id).await?;
        }
        sqlx::query("DELETE FROM vault_volumes WHERE token_id = ?").bind(token_id).execute(&self.db).await.map_err(db_err)?;
        self.placed.lock().unwrap().remove(token_id);
        self.short.lock().unwrap().remove(token_id);
        Ok(())
    }

    async fn reserve(&self, token_id: &str, capacity: u64, used: u64) -> io::Result<u64> {
        let v = self.place(token_id, capacity).await?;
        let (root, path, keep) = (v.root.clone(), v.root.join(token_id).join(RESERVE), self.keep_free_percent);
        let backed = self.short.lock().unwrap().get(token_id).map(|m| capacity.saturating_sub(*m));
        let backed = tokio::task::spawn_blocking(move || resize_reserve(&root, &path, capacity, used, backed, keep))
            .await
            .map_err(io::Error::other)??;
        let missing = capacity - backed;
        if missing > 0 && self.relocate(token_id, capacity).await.unwrap_or_else(|e| {
            tracing::warn!(token = %token_id, "storage: moving a drive that is short of space: {e}");
            false
        }) {
            // On its new volume, with its whole capacity reserved there.
            return Box::pin(self.reserve(token_id, capacity, used)).await;
        }
        let mut short = self.short.lock().unwrap();
        if missing > 0 {
            short.insert(token_id.to_owned(), missing);
        } else {
            short.remove(token_id);
        }
        Ok(missing)
    }

    fn shortage(&self, token_id: &str) -> u64 {
        self.short.lock().unwrap().get(token_id).copied().unwrap_or(0)
    }
}
