//! Etherdisk backend.
//!
//! The server never sees plaintext or keys: it stores the wrapped DEK, encrypted
//! metadata and encrypted blobs, and decides *who* may touch them by asking the
//! Etherdisk contract who owns the token right now.

pub mod auth;
pub mod chain;
pub mod config;
pub mod error;
pub mod handover;
pub mod ideas;
pub mod indexer;
pub mod objects;
pub mod range;
pub mod ratelimit;
pub mod shares;
pub mod storage;
pub mod volumes;
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
    pub limiter: ratelimit::Limiter,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: SqlitePool, store: Arc<dyn BlobStore>, chain: Ownership, config: Config) -> Self {
        Self(Arc::new(Inner { db, store, chain, config, uploads: Mutex::new(HashSet::new()), limiter: Default::default() }))
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

/// Ties the database to one deployment; the first start adopts the configured contract.
pub async fn bind_deployment(db: &SqlitePool, contract: alloy::primitives::Address, chain_id: u64) -> anyhow::Result<()> {
    let contract = format!("{contract:#x}");
    sqlx::query("INSERT OR IGNORE INTO deployment (id, contract, chain_id) VALUES (1, ?, ?)")
        .bind(&contract)
        .bind(chain_id as i64)
        .execute(db)
        .await?;
    let (bound, bound_chain): (String, i64) = sqlx::query_as("SELECT contract, chain_id FROM deployment WHERE id = 1").fetch_one(db).await?;
    if bound != contract || bound_chain != chain_id as i64 {
        anyhow::bail!(
            "this database belongs to contract {bound} on chain {bound_chain}, but CONTRACT_ADDRESS is {contract} on chain {chain_id}.              Token ids restart on a new contract, so its drives must not see the old files:              point DATABASE_URL and DATA_DIR to a new location (or delete the old data)."
        );
    }
    Ok(())
}

pub fn router(state: AppState) -> Router {
    use axum::middleware::from_fn_with_state;
    let auth = auth::routes().route_layer(from_fn_with_state(state.clone(), ratelimit::auth));
    let public = shares::routes()
        .merge(handover::routes())
        .merge(ideas::routes())
        .route_layer(from_fn_with_state(state.clone(), ratelimit::public));
    let rest = vaults::routes()
        .merge(objects::routes())
        .route_layer(from_fn_with_state(state.clone(), ratelimit::default));
    Router::new().nest("/api", auth.merge(public).merge(rest)).with_state(state)
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

    /// Same, for optional fields (null when absent).
    pub mod option {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use serde::Serializer;

        pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
            match v {
                Some(b) => s.serialize_str(&STANDARD.encode(b)),
                None => s.serialize_none(),
            }
        }
    }
}
