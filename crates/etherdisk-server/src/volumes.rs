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
//! share the disk); what doesn't fit is reported as a shortage.

use std::collections::HashMap;
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
    /// token id -> bytes of its reservation that didn't fit on its volume
    short: Mutex<HashMap<String, u64>>,
    /// Share of each volume (percent) that reservations leave free.
    keep_free_percent: u64,
}

/// Sets a reservation file to `want` bytes: shrinks it, or grows it with preallocated
/// blocks while the volume keeps `KEEP_FREE_PERCENT` free. Returns the bytes that didn't fit.
fn resize_reserve(root: &Path, path: &Path, want: u64, keep_free_percent: u64) -> io::Result<u64> {
    use fs4::FileExt;
    std::fs::create_dir_all(path.parent().expect("a vault folder"))?;
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path)?;
    let have = file.metadata()?.len();
    if want <= have {
        file.set_len(want)?;
        return Ok(0);
    }
    let floor = fs4::total_space(root)? * keep_free_percent / 100;
    let room = fs4::available_space(root)?.saturating_sub(floor);
    let target = want.min(have + room);
    if target > have {
        FileExt::allocate(&file, target)?;
    }
    Ok(want - target)
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

    /// Drives whose reservation didn't fit on their volume: (token id, missing bytes).
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
        self.place(token_of(key), 0).await?.store.append(key, body, max).await
    }

    async fn put(&self, key: &str, data: Bytes) -> io::Result<()> {
        self.place(token_of(key), 0).await?.store.put(key, data).await
    }

    async fn read_range(&self, key: &str, offset: u64, len: u64) -> io::Result<ByteStream> {
        match self.find(token_of(key)).await? {
            Some(v) => v.store.read_range(key, offset, len).await,
            None => Err(io::ErrorKind::NotFound.into()),
        }
    }

    async fn delete(&self, key: &str) -> io::Result<()> {
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

    async fn reserve(&self, token_id: &str, capacity: u64, bytes: u64) -> io::Result<u64> {
        let v = self.place(token_id, capacity).await?;
        let (root, path, keep) = (v.root.clone(), v.root.join(token_id).join(RESERVE), self.keep_free_percent);
        let missing = tokio::task::spawn_blocking(move || resize_reserve(&root, &path, bytes, keep)).await.map_err(io::Error::other)??;
        let mut short = self.short.lock().unwrap();
        if missing > 0 {
            short.insert(token_id.to_owned(), missing);
        } else {
            short.remove(token_id);
        }
        Ok(missing)
    }
}
