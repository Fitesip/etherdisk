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
pub mod monitor;
pub mod objects;
pub mod range;
pub mod ratelimit;
pub mod reserve;
pub mod sale;
pub mod shares;
pub mod storage;
pub mod tiers;
pub mod volumes;
pub mod vaults;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Requests answered with 5xx since start (the monitor watches for bursts).
    pub server_errors: AtomicU64,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: SqlitePool, store: Arc<dyn BlobStore>, chain: Ownership, config: Config) -> Self {
        Self(Arc::new(Inner { db, store, chain, config, uploads: Mutex::new(HashSet::new()), limiter: Default::default(), server_errors: AtomicU64::new(0) }))
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
/// A database of `legacy` moves on to its successor `contract` (docs/MIGRATION.md): drives
/// keep their ids, so their files stay theirs. Mint counts per tier start over, since tier
/// ids belong to a contract.
pub async fn bind_deployment(
    db: &SqlitePool,
    contract: alloy::primitives::Address,
    chain_id: u64,
    legacies: &[alloy::primitives::Address],
) -> anyhow::Result<()> {
    let contract = format!("{contract:#x}");
    for legacy in legacies {
        let legacy = format!("{legacy:#x}");
        let moved = sqlx::query("UPDATE deployment SET contract = ? WHERE id = 1 AND contract = ? AND chain_id = ?")
            .bind(&contract)
            .bind(&legacy)
            .bind(chain_id as i64)
            .execute(db)
            .await?
            .rows_affected();
        if moved > 0 {
            sqlx::query("DELETE FROM tier_mints").execute(db).await?;
            tracing::info!(%legacy, successor = %contract, "database moved on to the successor contract");
        }
    }
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
        .merge(tiers::routes())
        .merge(sale::public_routes())
        .route_layer(from_fn_with_state(state.clone(), read_only_on_old_contract))
        .route_layer(from_fn_with_state(state.clone(), ratelimit::public));
    let rest = vaults::routes()
        .merge(sale::routes())
        .merge(objects::routes())
        .route_layer(from_fn_with_state(state.clone(), read_only_on_old_contract))
        .route_layer(from_fn_with_state(state.clone(), ratelimit::default));
    Router::new()
        .nest("/api", auth.merge(public).merge(rest))
        .layer(axum::middleware::map_response_with_state(state.clone(), count_errors))
        .with_state(state)
}

/// A drive still on an earlier contract opens and downloads as before, but nothing about it
/// changes until it moves to the current one (docs/MIGRATION.md): any write to a route with
/// the drive's `{token_id}` (links and handover included) is refused with `old_contract`.
async fn read_only_on_old_contract(
    axum::extract::State(st): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use axum::RequestPartsExt;
    let writes = !matches!(*req.method(), axum::http::Method::GET | axum::http::Method::HEAD);
    if !writes || st.config.legacy_contract_addresses.is_empty() {
        return next.run(req).await;
    }
    // The route's own parameter, decoded as the handler sees it (`%31` and `01` are drive 1).
    let (mut parts, body) = req.into_parts();
    let token = match parts.extract::<axum::extract::RawPathParams>().await {
        Ok(params) => params.iter().find(|(name, _)| *name == "token_id").and_then(|(_, id)| vaults::parse_token(id).ok()),
        Err(_) => None,
    };
    let req = axum::extract::Request::from_parts(parts, body);
    if let Some(token) = token {
        match st.chain.on_legacy(token).await {
            Ok(Some(_)) => return AppError::OldContract.into_response(),
            Ok(None) => {}
            Err(e) => return e.into_response(),
        }
    }
    next.run(req).await
}

async fn count_errors(axum::extract::State(st): axum::extract::State<AppState>, res: axum::response::Response) -> axum::response::Response {
    if res.status().is_server_error() {
        st.server_errors.fetch_add(1, Ordering::Relaxed);
    }
    res
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
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
            match v {
                Some(b) => s.serialize_str(&STANDARD.encode(b)),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
            Option::<String>::deserialize(d)?.map(|s| STANDARD.decode(s).map_err(serde::de::Error::custom)).transpose()
        }
    }
}
