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
        .route("/vaults/{token_id}/prefs", get(get_prefs).put(put_prefs))
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

/// Owner-chosen name, colors, icon and cover. Plaintext, so the drive list can show them
/// while locked.
#[derive(Serialize, Deserialize, Default, sqlx::FromRow)]
pub struct Profile {
    name: Option<String>,
    /// '#rrggbb'
    stroke: Option<String>,
    fill: Option<String>,
    /// Ids from the app's icon and cover sets (`[a-z0-9-]`); the app falls back to its
    /// default for ids it doesn't know.
    icon: Option<String>,
    cover: Option<String>,
    /// '#rrggbb' of the cover pattern; null = the fill color.
    cover_color: Option<String>,
}

pub const MAX_NAME_CHARS: usize = 64;
const MAX_STYLE_ID: usize = 32;
/// Sealed drive-wide settings (labels and the like): a few KiB in practice.
pub const MAX_PREFS: usize = 64 * 1024;

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
    let profile = sqlx::query_as::<_, Profile>("SELECT name, stroke, fill, icon, cover, cover_color FROM vault_profiles WHERE token_id = ?")
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

/// The drives `owner` holds: listed from Transfer events (`token_owners`), each one
/// confirmed with `ownerOf`, so a lagging indexer can hide a new drive for a moment but
/// never show someone else's.
pub(crate) async fn drives_of(st: &AppState, owner: Address) -> AppResult<Vec<U256>> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT token_id FROM token_owners WHERE owner = ? ORDER BY CAST(token_id AS INTEGER)")
        .bind(format!("{owner:#x}"))
        .fetch_all(&st.db)
        .await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let id = parse_token(&id)?;
        if st.chain.owner_of(id).await? == Some(owner) {
            out.push(id);
        }
    }
    Ok(out)
}

/// All vaults of the signed-in wallet (rendered as separate disks).
async fn list(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<VaultInfo>>> {
    let mut out = Vec::new();
    for id in drives_of(&st, user.0).await? {
        out.push(info(&st, id, user.0).await?);
    }
    Ok(Json(out))
}

/// One drive of the caller. Also records them as its holder (just checked with ownerOf), so
/// a drive minted a moment ago is listed before the indexer sees its Transfer event.
async fn one(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<VaultInfo>> {
    let (id, token) = owned(&st, &user, &token_id).await?;
    sqlx::query(
        "INSERT INTO token_owners (token_id, owner) VALUES (?, ?)
         ON CONFLICT (token_id) DO UPDATE SET owner = excluded.owner WHERE owner <> excluded.owner",
    )
    .bind(&token)
    .bind(format!("{:#x}", user.0))
    .execute(&st.db)
    .await?;
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

fn clean_style_id(id: Option<String>, what: &str) -> AppResult<Option<String>> {
    match id {
        None => Ok(None),
        Some(s) if !s.is_empty() && s.len() <= MAX_STYLE_ID && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') => Ok(Some(s)),
        Some(_) => Err(AppError::bad(format!("{what} must be 1..={MAX_STYLE_ID} of a-z, 0-9, -"))),
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
    let p = Profile {
        name: clean_name(req.name)?,
        stroke: clean_color(req.stroke)?,
        fill: clean_color(req.fill)?,
        icon: clean_style_id(req.icon, "icon")?,
        cover: clean_style_id(req.cover, "cover")?,
        cover_color: clean_color(req.cover_color)?,
    };
    sqlx::query(
        "INSERT INTO vault_profiles (token_id, name, stroke, fill, icon, cover, cover_color, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET name = excluded.name, stroke = excluded.stroke,
            fill = excluded.fill, icon = excluded.icon, cover = excluded.cover,
            cover_color = excluded.cover_color, updated_at = excluded.updated_at",
    )
    .bind(&token)
    .bind(&p.name)
    .bind(&p.stroke)
    .bind(&p.fill)
    .bind(&p.icon)
    .bind(&p.cover)
    .bind(&p.cover_color)
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
    /// The drive's older keys, sealed under the current one (null: never changed hands).
    #[serde(with = "b64::option")]
    keyring: Option<Vec<u8>>,
    /// The current key was made by another wallet (the drive changed hands): the caller
    /// should choose their own passphrase and make a new key (`rotate`).
    needs_new_key: bool,
}

fn needs_new_key(rotated_by: &Option<String>, caller: &Address) -> bool {
    rotated_by.as_ref().is_some_and(|by| *by != format!("{caller:#x}"))
}

pub(crate) fn etag(blob: &[u8]) -> String {
    alloy::hex::encode(Sha256::digest(blob))
}

async fn get_key(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<KeyResponse>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let (blob, keyring, rotated_by): (Vec<u8>, Option<Vec<u8>>, Option<String>) =
        sqlx::query_as("SELECT key_blob, keyring, rotated_by FROM vault_keys WHERE token_id = ?")
            .bind(&token)
            .fetch_optional(&st.db)
            .await?
            .ok_or(AppError::NotFound)?;
    Ok(Json(KeyResponse { etag: etag(&blob), needs_new_key: needs_new_key(&rotated_by, &user.0), key_blob: blob, keyring }))
}

#[derive(Deserialize)]
struct PutKeyRequest {
    #[serde(with = "b64")]
    key_blob: Vec<u8>,
    /// `null` to initialize a fresh vault; the current etag to change the passphrase.
    /// Guards against overwriting a blob the client has not seen (lost DEK = lost files).
    previous_etag: Option<String>,
    /// The blob wraps a new drive key (`rotate`): `keyring` holds the older keys. The
    /// caller becomes the key's maker; recovery keys of the old key stop being served.
    #[serde(default)]
    rotate: bool,
    #[serde(default, with = "b64::option")]
    keyring: Option<Vec<u8>>,
}

/// A sealed keyring: nonce (24) + tag (16) + 32 bytes per older key.
const MAX_KEYRING: usize = 40 + 32 * 1024;

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

    if req.rotate != req.keyring.is_some() || req.keyring.as_ref().is_some_and(|k| k.len() < 40 || k.len() > MAX_KEYRING) {
        return Err(AppError::bad("a new key comes with its keyring, and only then"));
    }

    let mut tx = st.db.begin().await?;
    let current: Option<Vec<u8>> = sqlx::query_scalar("SELECT key_blob FROM vault_keys WHERE token_id = ?")
        .bind(&token)
        .fetch_optional(&mut *tx)
        .await?;
    if req.rotate && current.is_none() {
        return Err(AppError::conflict("vault is not initialized"));
    }
    match (&current, &req.previous_etag) {
        (None, None) => {}
        (Some(cur), Some(prev)) if etag(cur) == *prev => {}
        (None, Some(_)) => return Err(AppError::conflict("vault is not initialized")),
        (Some(_), _) => return Err(AppError::conflict("key blob changed; reload it first")),
    }
    // The UPSERT keeps this atomic with the check above (SQLite serializes writers;
    // a concurrent writer makes this transaction fail instead of overwriting).
    let me = format!("{:#x}", user.0);
    if current.is_none() {
        // Two first set-ups racing: the second gets a conflict, not an error.
        let n = sqlx::query(
            "INSERT INTO vault_keys (token_id, key_blob, updated_at, rotated_by) VALUES (?, ?, ?, ?) ON CONFLICT (token_id) DO NOTHING",
        )
        .bind(&token)
        .bind(&req.key_blob)
        .bind(now())
        .bind(&me)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(AppError::conflict("key blob changed; reload it first"));
        }
    } else if req.rotate {
        sqlx::query("UPDATE vault_keys SET key_blob = ?, keyring = ?, rotated_by = ?, updated_at = ? WHERE token_id = ?")
            .bind(&req.key_blob)
            .bind(&req.keyring)
            .bind(&me)
            .bind(now())
            .bind(&token)
            .execute(&mut *tx)
            .await?;
        // Wrapped the old key: useless now, and its words must not open the new one.
        sqlx::query("DELETE FROM vault_recovery WHERE token_id = ?").bind(&token).execute(&mut *tx).await?;
    } else {
        // A new passphrase for the same key. A drive from before rotation adopts its owner.
        sqlx::query("UPDATE vault_keys SET key_blob = ?, rotated_by = COALESCE(rotated_by, ?), updated_at = ? WHERE token_id = ?")
            .bind(&req.key_blob)
            .bind(&me)
            .bind(now())
            .bind(&token)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let keyring: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT keyring FROM vault_keys WHERE token_id = ?").bind(&token).fetch_one(&st.db).await?;
    Ok(Json(KeyResponse { etag: etag(&req.key_blob), key_blob: req.key_blob, keyring, needs_new_key: false }))
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
#[derive(Serialize, Deserialize)]
struct Prefs {
    /// Sealed by the app with the drive key; null if never saved.
    #[serde(with = "b64::option")]
    blob: Option<Vec<u8>>,
}

/// Drive-wide settings, sealed: only the holder reads or replaces them.
async fn get_prefs(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Prefs>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let blob = sqlx::query_scalar("SELECT blob FROM vault_prefs WHERE token_id = ?").bind(&token).fetch_optional(&st.db).await?;
    Ok(Json(Prefs { blob }))
}

/// Replaces the settings; a null or empty blob removes them.
async fn put_prefs(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>, Json(req): Json<Prefs>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let Some(blob) = req.blob.filter(|b| !b.is_empty()) else {
        sqlx::query("DELETE FROM vault_prefs WHERE token_id = ?").bind(&token).execute(&st.db).await?;
        return Ok(StatusCode::NO_CONTENT);
    };
    if blob.len() > MAX_PREFS {
        return Err(AppError::bad(format!("prefs must be at most {MAX_PREFS} bytes")));
    }
    sqlx::query(
        "INSERT INTO vault_prefs (token_id, blob, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(&token)
    .bind(&blob)
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

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
    sqlx::query("DELETE FROM vault_prefs WHERE token_id = ?").bind(token).execute(&mut *tx).await?;
    tx.commit().await?;
    st.store.delete_vault(token).await?;
    Ok(())
}
