//! NFT Vault backend.
//!
//! The server never sees plaintext or keys: it stores the wrapped DEK, encrypted
//! metadata and encrypted blobs, and decides *who* may touch them by asking the
//! VaultNFT contract who owns the token right now.

pub mod auth;
pub mod chain;
pub mod config;
pub mod error;
pub mod indexer;
pub mod objects;
pub mod range;
pub mod shares;
pub mod storage;
pub mod vaults;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::Router;
use sqlx::SqlitePool;

pub use config::Config;
pub use error::{AppError, AppResult};

use chain::Ownership;
use storage::BlobStore;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: SqlitePool,
    pub store: Arc<dyn BlobStore>,
    pub chain: Ownership,
    pub config: Config,
    /// Objects with an upload request in flight (one writer per object).
    uploads: Mutex<HashSet<uuid::Uuid>>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: SqlitePool, store: Arc<dyn BlobStore>, chain: Ownership, config: Config) -> Self {
        Self(Arc::new(Inner { db, store, chain, config, uploads: Mutex::new(HashSet::new()) }))
    }

    /// Marks `id` as being written to. `None` if another request already holds it.
    pub(crate) fn lock_upload(&self, id: uuid::Uuid) -> Option<UploadGuard> {
        self.uploads.lock().unwrap().insert(id).then(|| UploadGuard { state: self.clone(), id })
    }
}

pub(crate) struct UploadGuard {
    state: AppState,
    id: uuid::Uuid,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        self.state.uploads.lock().unwrap().remove(&self.id);
    }
}

pub async fn connect_db(url: &str) -> anyhow::Result<SqlitePool> {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::str::FromStr;
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new().connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .nest(
            "/api",
            Router::new()
                .merge(auth::routes())
                .merge(vaults::routes())
                .merge(objects::routes())
                .merge(shares::routes()),
        )
        .with_state(state)
}

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("OS RNG");
    alloy::hex::encode(b)
}

/// Base64 (standard, padded) for binary fields in JSON.
pub(crate) mod b64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}
