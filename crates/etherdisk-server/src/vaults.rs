//! Vaults (one per token): listing, the wrapped key blob, and reset.

use alloy::primitives::{Address, U256};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::auth::AuthUser;
use crate::{b64, now, AppError, AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/vaults", get(list))
        .route("/vaults/{token_id}", get(one))
        .route("/vaults/{token_id}/key", get(get_key).put(put_key))
        .route("/vaults/{token_id}/recovery", get(get_recovery).put(put_recovery).delete(delete_recovery))
        .route("/vaults/{token_id}/reset", post(reset))
        .route("/vaults/{token_id}/profile", put(put_profile))
}

pub(crate) fn parse_token(s: &str) -> AppResult<U256> {
    U256::from_str_radix(s, 10).map_err(|_| AppError::NotFound)
}

/// Checks the caller owns the token; returns its id and the DB key (decimal string).
pub(crate) async fn owned(st: &AppState, user: &AuthUser, token_id: &str) -> AppResult<(U256, String)> {
    let id = parse_token(token_id)?;
    st.chain.require_owner(id, user.0).await?;
    Ok((id, id.to_string()))
}

/// Bytes reserved by the vault: ciphertext of files and thumbnails, including uploads in progress.
async fn used_bytes(st: &AppState, token: &str) -> AppResult<u64> {
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size + COALESCE(thumb_size, 0)), 0) FROM objects WHERE token_id = ?")
        .bind(token)
        .fetch_one(&st.db)
        .await?;
    Ok(used as u64)
}

#[derive(Serialize)]
pub struct VaultInfo {
    /// Decimal string: uint256 does not fit a JS number.
    token_id: String,
    capacity_bytes: u64,
    used_bytes: u64,
    /// Whether a passphrase/key blob has been set up.
    initialized: bool,
    /// When the current owner saved a recovery key, if they did.
    recovery_at: Option<i64>,
    #[serde(flatten)]
    profile: Profile,
}

/// Owner-chosen name and colors. Plaintext, so the drive list can show them while locked.
#[derive(Serialize, Deserialize, Default, sqlx::FromRow)]
pub struct Profile {
    name: Option<String>,
    /// '#rrggbb'
    stroke: Option<String>,
    fill: Option<String>,
}

pub const MAX_NAME_CHARS: usize = 64;

/// `owner`: the caller, who holds the token (recovery keys are per holder).
async fn info(st: &AppState, id: U256, owner: Address) -> AppResult<VaultInfo> {
    let token = id.to_string();
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM vault_keys WHERE token_id = ?)")
        .bind(&token)
        .fetch_one(&st.db)
        .await?;
    let recovery_at: Option<i64> = sqlx::query_scalar(
        "SELECT r.created_at FROM vault_recovery r WHERE r.token_id = ? AND r.created_by = ?",
    )
    .bind(&token)
    .bind(format!("{owner:#x}"))
    .fetch_optional(&st.db)
    .await?;
    let profile = sqlx::query_as::<_, Profile>("SELECT name, stroke, fill FROM vault_profiles WHERE token_id = ?")
        .bind(&token)
        .fetch_optional(&st.db)
        .await?
        .unwrap_or_default();
    Ok(VaultInfo {
        profile,
        capacity_bytes: st.chain.capacity_bytes(id).await?,
        used_bytes: used_bytes(st, &token).await?,
        initialized,
        recovery_at,
        token_id: token,
    })
}

/// All vaults of the signed-in wallet (rendered as separate disks).
async fn list(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<VaultInfo>>> {
    let mut out = Vec::new();
    for id in st.chain.tokens_of_owner(user.0).await? {
        out.push(info(&st, id, user.0).await?);
    }
    Ok(Json(out))
}

async fn one(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<VaultInfo>> {
    let (id, _) = owned(&st, &user, &token_id).await?;
    Ok(Json(info(&st, id, user.0).await?))
}

fn clean_name(name: Option<String>) -> AppResult<Option<String>> {
    let Some(name) = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()) else { return Ok(None) };
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(AppError::bad(format!("name must be at most {MAX_NAME_CHARS} printable characters")));
    }
    Ok(Some(name))
}

fn clean_color(c: Option<String>) -> AppResult<Option<String>> {
    match c {
        None => Ok(None),
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()) => Ok(Some(c.to_ascii_lowercase())),
        Some(_) => Err(AppError::bad("colors must be #rrggbb")),
    }
}

/// Replaces the whole profile; `null` fields reset to defaults.
async fn put_profile(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<Profile>,
) -> AppResult<Json<VaultInfo>> {
    let (id, token) = owned(&st, &user, &token_id).await?;
    let p = Profile { name: clean_name(req.name)?, stroke: clean_color(req.stroke)?, fill: clean_color(req.fill)? };
    sqlx::query(
        "INSERT INTO vault_profiles (token_id, name, stroke, fill, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET name = excluded.name, stroke = excluded.stroke,
            fill = excluded.fill, updated_at = excluded.updated_at",
    )
    .bind(&token)
    .bind(&p.name)
    .bind(&p.stroke)
    .bind(&p.fill)
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(Json(info(&st, id, user.0).await?))
}

#[derive(Serialize)]
struct KeyResponse {
    #[serde(with = "b64")]
    key_blob: Vec<u8>,
    /// Pass back as `previous_etag` when replacing the blob.
    etag: String,
}

pub(crate) fn etag(blob: &[u8]) -> String {
    alloy::hex::encode(Sha256::digest(blob))
}

async fn get_key(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<KeyResponse>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let blob: Vec<u8> = sqlx::query_scalar("SELECT key_blob FROM vault_keys WHERE token_id = ?")
        .bind(&token)
        .fetch_optional(&st.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(KeyResponse { etag: etag(&blob), key_blob: blob }))
}

#[derive(Deserialize)]
struct PutKeyRequest {
    #[serde(with = "b64")]
    key_blob: Vec<u8>,
    /// `null` to initialize a fresh vault; the current etag to change the passphrase.
    /// Guards against overwriting a blob the client has not seen (lost DEK = lost files).
    previous_etag: Option<String>,
}

async fn put_key(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<PutKeyRequest>,
) -> AppResult<Json<KeyResponse>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    if req.key_blob.len() != etherdisk_crypto::KEY_BLOB_LEN || !req.key_blob.starts_with(b"NVK1") {
        return Err(AppError::bad("not a vault key blob"));
    }

    let mut tx = st.db.begin().await?;
    let current: Option<Vec<u8>> = sqlx::query_scalar("SELECT key_blob FROM vault_keys WHERE token_id = ?")
        .bind(&token)
        .fetch_optional(&mut *tx)
        .await?;
    match (&current, &req.previous_etag) {
        (None, None) => {}
        (Some(cur), Some(prev)) if etag(cur) == *prev => {}
        (None, Some(_)) => return Err(AppError::conflict("vault is not initialized")),
        (Some(_), _) => return Err(AppError::conflict("key blob changed; reload it first")),
    }
    // The UPSERT keeps this atomic with the check above (SQLite serializes writers;
    // a concurrent writer makes this transaction fail instead of overwriting).
    sqlx::query(
        "INSERT INTO vault_keys (token_id, key_blob, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET key_blob = excluded.key_blob, updated_at = excluded.updated_at",
    )
    .bind(&token)
    .bind(&req.key_blob)
    .bind(now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(KeyResponse { etag: etag(&req.key_blob), key_blob: req.key_blob }))
}

#[derive(Serialize, Deserialize)]
struct Recovery {
    /// The drive key wrapped under the recovery words (`Vault::wrap_for_recovery`).
    #[serde(with = "b64")]
    blob: Vec<u8>,
    #[serde(default, skip_deserializing)]
    created_at: i64,
}

/// The caller's recovery blob, to open the drive with the words when the passphrase is lost.
async fn get_recovery(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Recovery>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let row: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT blob, created_at FROM vault_recovery WHERE token_id = ? AND created_by = ?")
            .bind(&token)
            .bind(format!("{:#x}", user.0))
            .fetch_optional(&st.db)
            .await?;
    let (blob, created_at) = row.ok_or(AppError::NotFound)?;
    Ok(Json(Recovery { blob, created_at }))
}

/// Saves (or replaces: the previous words stop working) the caller's recovery blob.
async fn put_recovery(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<Recovery>,
) -> AppResult<Json<Recovery>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    if req.blob.len() != etherdisk_crypto::RECOVERY_BLOB_LEN || !req.blob.starts_with(b"EDR1") {
        return Err(AppError::bad("not a recovery blob"));
    }
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM vault_keys WHERE token_id = ?)")
        .bind(&token)
        .fetch_one(&st.db)
        .await?;
    if !initialized {
        return Err(AppError::conflict("vault is not initialized"));
    }
    let created_at = now();
    sqlx::query(
        "INSERT INTO vault_recovery (token_id, blob, created_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET blob = excluded.blob, created_by = excluded.created_by, created_at = excluded.created_at",
    )
    .bind(&token)
    .bind(&req.blob)
    .bind(format!("{:#x}", user.0))
    .bind(created_at)
    .execute(&st.db)
    .await?;
    Ok(Json(Recovery { blob: req.blob, created_at }))
}

async fn delete_recovery(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    sqlx::query("DELETE FROM vault_recovery WHERE token_id = ?").bind(&token).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Indexer hook: the previous holder's recovery key must not open the drive for its new
/// owner's files. Keeps a key the new owner already saved (the indexer may lag behind).
pub async fn on_transfer(st: &AppState, to: Address, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM vault_recovery WHERE token_id = ? AND created_by <> ?")
        .bind(token)
        .bind(format!("{to:#x}"))
        .execute(&st.db)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct ResetRequest {
    /// Must be exactly "DELETE".
    confirm: String,
}

/// Irreversibly wipes the vault: files, thumbnails, metadata, links and the key blob.
/// The token stays; the owner sets up a new passphrase afterwards.
async fn reset(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<ResetRequest>,
) -> AppResult<StatusCode> {
    if req.confirm != "DELETE" {
        return Err(AppError::bad("confirm must be \"DELETE\""));
    }
    let (_, token) = owned(&st, &user, &token_id).await?;
    wipe(&st, &token).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn wipe(st: &AppState, token: &str) -> AppResult<()> {
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM shares WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM objects WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM vault_keys WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM handovers WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM handover_skips WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM vault_recovery WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    tx.commit().await?;
    st.store.delete_vault(token).await?;
    Ok(())
}
