//! Several storage directories ("volumes", e.g. one per RAID array). Each vault lives
//! entirely on one volume, recorded in `vault_volumes`; a new vault goes to the volume
//! with the most free space. Every directory holds a marker file with its volume id, so
//! a vault stays tied to its volume when paths or their order change in the config. A
//! volume that is configured away (or not mounted) makes its vaults fail with an error
//! instead of silently starting over on another volume.

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
    pub available_bytes: u64,
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
        let store = Self { volumes, db, placed: Mutex::new(HashMap::new()) };
        for (id, vaults) in store.missing().await? {
            tracing::error!(volume = %id, vaults, "storage volume is not configured or not mounted: its drives are unavailable");
        }
        Ok(store)
    }

    /// Every configured volume with its free space and number of vaults.
    pub async fn info(&self) -> io::Result<Vec<VolumeInfo>> {
        let mut out = Vec::with_capacity(self.volumes.len());
        for v in &self.volumes {
            let vaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_volumes WHERE volume = ?")
                .bind(&v.id)
                .fetch_one(&self.db)
                .await
                .map_err(db_err)?;
            out.push(VolumeInfo {
                id: v.id.clone(),
                root: v.root.clone(),
                total_bytes: fs4::total_space(&v.root)?,
                available_bytes: fs4::available_space(&v.root)?,
                vaults,
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

    /// The vault's volume; a new vault goes where the most space is free. Free space within
    /// `FREE_SPACE_TIE` counts as equal (volumes on one disk, or a disk others keep writing
    /// to, never read exactly the same): then the volume with the fewest vaults wins.
    async fn place(&self, token: &str) -> io::Result<&Volume> {
        if let Some(v) = self.find(token).await? {
            return Ok(v);
        }
        let mut best: Option<(u64, i64, &Volume)> = None;
        for info in self.info().await? {
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
        self.place(token_of(key)).await?.store.append(key, body, max).await
    }

    async fn put(&self, key: &str, data: Bytes) -> io::Result<()> {
        self.place(token_of(key)).await?.store.put(key, data).await
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
        Ok(())
    }
}
