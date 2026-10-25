//! Handing a drive's key to its next owner.
//!
//! A user publishes an inbox key (X25519 public key, see `etherdisk_crypto::inbox`) together
//! with a wallet signature binding it to their address; senders verify that signature
//! themselves, so the server cannot swap in its own key. The drive key (DEK) is sealed
//! to the recipient's inbox in the sender's browser; the server only stores ciphertext.
//!
//! One handover per token:
//! - before a transfer made in the app, the owner may seal the key to the recipient;
//! - when the indexer sees a `Transfer`, it records a request from the previous owner,
//!   who can then fulfil it from any device (the wrapped key blob is returned to them
//!   while it is unchanged, so they can unlock it with their passphrase);
//! - unless the owner chose in the app to transfer without the key (`handover/skip`).

use alloy::primitives::{Address, Signature};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::vaults::{etag, owned, parse_token};
use crate::{b64, now, AppError, AppResult, AppState};

pub const INBOX_KEY_LEN: usize = etherdisk_crypto::inbox::INBOX_PUBLIC_LEN;
/// A sealed 32-byte drive key.
pub const SEALED_LEN: usize = etherdisk_crypto::inbox::SEALED_OVERHEAD + 32;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/inbox", put(put_inbox))
        .route("/inbox/{address}", get(get_inbox))
        .route("/handovers/outgoing", get(outgoing))
        .route("/handovers/outgoing/{token_id}", delete(decline))
        .route("/vaults/{token_id}/handover", get(incoming).post(seal).delete(dismiss))
        .route("/vaults/{token_id}/handover/skip", post(skip))
}

/// The exact text a user signs to publish their inbox key (the client builds the same).
pub fn inbox_message(address: &Address, key: &[u8]) -> String {
    format!(
        "Etherdisk inbox key\n\nPublishing this key lets people who send you a drive include its key, encrypted so only you can open it.\n\nAddress: {address:#x}\nKey: {}",
        alloy::hex::encode(key)
    )
}

fn lower(a: &Address) -> String {
    format!("{a:#x}")
}

#[derive(Serialize, Deserialize, sqlx::FromRow)]
pub struct InboxKey {
    #[serde(with = "b64")]
    pubkey: Vec<u8>,
    /// 0x-hex wallet signature over `inbox_message`.
    signature: String,
}

async fn put_inbox(State(st): State<AppState>, user: AuthUser, Json(req): Json<InboxKey>) -> AppResult<StatusCode> {
    if req.pubkey.len() != INBOX_KEY_LEN {
        return Err(AppError::bad("inbox key must be 32 bytes"));
    }
    let sig_bytes = alloy::hex::decode(&req.signature).map_err(|_| AppError::bad("malformed signature"))?;
    let sig = Signature::try_from(sig_bytes.as_slice()).map_err(|_| AppError::bad("malformed signature"))?;
    let signer = sig
        .recover_address_from_msg(inbox_message(&user.0, &req.pubkey))
        .map_err(|_| AppError::bad("invalid signature"))?;
    if signer != user.0 {
        return Err(AppError::bad("the signature is not from this wallet"));
    }
    sqlx::query(
        "INSERT INTO inbox_keys (address, pubkey, signature, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET pubkey = excluded.pubkey, signature = excluded.signature, created_at = excluded.created_at",
    )
    .bind(lower(&user.0))
    .bind(&req.pubkey)
    .bind(&req.signature)
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn find_inbox(st: &AppState, address: &str) -> AppResult<Option<InboxKey>> {
    Ok(sqlx::query_as("SELECT pubkey, signature FROM inbox_keys WHERE address = ?")
        .bind(address.to_lowercase())
        .fetch_optional(&st.db)
        .await?)
}

/// Public: anyone may look up an inbox key; they must check the signature themselves.
async fn get_inbox(State(st): State<AppState>, Path(address): Path<String>) -> AppResult<Json<InboxKey>> {
    let address: Address = address.parse().map_err(|_| AppError::NotFound)?;
    find_inbox(&st, &lower(&address)).await?.map(Json).ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct SealRequest {
    to: Address,
    #[serde(with = "b64")]
    sealed: Vec<u8>,
}

/// Stores the drive key sealed to `to`: either by the owner just before transferring,
/// or by the previous owner answering the request the indexer recorded.
async fn seal(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<SealRequest>,
) -> AppResult<StatusCode> {
    if req.sealed.len() != SEALED_LEN {
        return Err(AppError::bad("sealed key has the wrong size"));
    }
    let id = parse_token(&token_id)?;
    let token = id.to_string();
    let (me, to) = (lower(&user.0), lower(&req.to));
    if me == to {
        return Err(AppError::bad("cannot hand a drive to yourself"));
    }
    let owner = st.chain.owner_of(id).await?;
    if owner == Some(user.0) {
        // Before the transfer: replaces any earlier request or skip for this token.
        sqlx::query("DELETE FROM handover_skips WHERE token_id = ?").bind(&token).execute(&st.db).await?;
        sqlx::query(
            "INSERT INTO handovers (token_id, from_addr, to_addr, sealed, key_etag, created_at) VALUES (?, ?, ?, ?, NULL, ?)
             ON CONFLICT (token_id) DO UPDATE SET from_addr = excluded.from_addr, to_addr = excluded.to_addr,
                sealed = excluded.sealed, key_etag = NULL, created_at = excluded.created_at",
        )
        .bind(&token)
        .bind(&me)
        .bind(&to)
        .bind(&req.sealed)
        .bind(now())
        .execute(&st.db)
        .await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    // After the transfer: only the previous owner, only for the current owner.
    if owner != Some(req.to) {
        return Err(AppError::Forbidden);
    }
    let n = sqlx::query("UPDATE handovers SET sealed = ? WHERE token_id = ? AND from_addr = ? AND to_addr = ?")
        .bind(&req.sealed)
        .bind(&token)
        .bind(&me)
        .bind(&to)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::Forbidden);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SkipRequest {
    to: Address,
}

/// Before a transfer made in the app without the key: the owner doesn't want to be asked
/// for it, so the indexer records no request for this recipient. Replaces a sealed key.
async fn skip(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>, Json(req): Json<SkipRequest>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let (me, to) = (lower(&user.0), lower(&req.to));
    if me == to {
        return Err(AppError::bad("cannot hand a drive to yourself"));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("DELETE FROM handovers WHERE token_id = ?").bind(&token).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO handover_skips (token_id, from_addr, to_addr, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET from_addr = excluded.from_addr, to_addr = excluded.to_addr, created_at = excluded.created_at",
    )
    .bind(&token)
    .bind(&me)
    .bind(&to)
    .bind(now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Incoming {
    from: String,
    /// The drive key sealed to the caller's inbox, once the previous owner provided it.
    #[serde(with = "b64::option")]
    sealed: Option<Vec<u8>>,
    created_at: i64,
}

/// For the current owner: a handover addressed to them, if any.
async fn incoming(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Incoming>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let row: Option<(String, Option<Vec<u8>>, i64)> =
        sqlx::query_as("SELECT from_addr, sealed, created_at FROM handovers WHERE token_id = ? AND to_addr = ?")
            .bind(&token)
            .bind(lower(&user.0))
            .fetch_optional(&st.db)
            .await?;
    let (from, sealed, created_at) = row.ok_or(AppError::NotFound)?;
    Ok(Json(Incoming { from, sealed, created_at }))
}

/// The current owner is done with it (received the key, or doesn't want it).
async fn dismiss(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    sqlx::query("DELETE FROM handovers WHERE token_id = ? AND to_addr = ?")
        .bind(&token)
        .bind(lower(&user.0))
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Outgoing {
    token_id: String,
    to: String,
    /// The drive's wrapped key, while unchanged since the transfer: unlock it with your
    /// passphrase to seal the key for the recipient. Null once the new owner changed it.
    #[serde(with = "b64::option")]
    key_blob: Option<Vec<u8>>,
    /// The recipient's inbox, once they published one.
    recipient: Option<InboxKey>,
    name: Option<String>,
    created_at: i64,
}

#[derive(sqlx::FromRow)]
struct OutgoingRow {
    token_id: String,
    to_addr: String,
    key_etag: Option<String>,
    created_at: i64,
    key_blob: Option<Vec<u8>>,
    name: Option<String>,
}

/// Drives the caller handed over (outside the app or without sealing) still waiting for their key.
async fn outgoing(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<Outgoing>>> {
    let rows: Vec<OutgoingRow> = sqlx::query_as(
        "SELECT h.token_id, h.to_addr, h.key_etag, h.created_at, k.key_blob, p.name
         FROM handovers h
         LEFT JOIN vault_keys k ON k.token_id = h.token_id
         LEFT JOIN vault_profiles p ON p.token_id = h.token_id
         WHERE h.from_addr = ? AND h.sealed IS NULL ORDER BY h.created_at DESC",
    )
    .bind(lower(&user.0))
    .fetch_all(&st.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let key_blob = match (r.key_blob, r.key_etag) {
            (Some(b), Some(e)) if etag(&b) == e => Some(b),
            _ => None,
        };
        let recipient = find_inbox(&st, &r.to_addr).await?;
        out.push(Outgoing { token_id: r.token_id, to: r.to_addr, key_blob, recipient, name: r.name, created_at: r.created_at });
    }
    Ok(Json(out))
}

/// The previous owner declines to hand the key over.
async fn decline(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<StatusCode> {
    let token = parse_token(&token_id)?.to_string();
    sqlx::query("DELETE FROM handovers WHERE token_id = ? AND from_addr = ? AND sealed IS NULL")
        .bind(&token)
        .bind(lower(&user.0))
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Drops the request for the key that a transfer made (the drive was sold without it).
pub async fn drop_request(st: &AppState, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM handovers WHERE token_id = ? AND sealed IS NULL").bind(token).execute(&st.db).await?;
    Ok(())
}

/// Indexer hook: a transfer of an initialized drive asks the previous owner for its key,
/// unless they already sealed it for exactly this recipient or chose to send none.
pub async fn on_transfer(st: &AppState, from: Address, to: Address, token: &str) -> AppResult<()> {
    let (from, to) = (lower(&from), lower(&to));
    // A skip applies to exactly the transfer it was made for; any other one drops it.
    let skipped = sqlx::query("DELETE FROM handover_skips WHERE token_id = ? AND from_addr = ? AND to_addr = ?")
        .bind(token)
        .bind(&from)
        .bind(&to)
        .execute(&st.db)
        .await?
        .rows_affected()
        > 0;
    sqlx::query("DELETE FROM handover_skips WHERE token_id = ?").bind(token).execute(&st.db).await?;
    let blob: Option<Vec<u8>> = sqlx::query_scalar("SELECT key_blob FROM vault_keys WHERE token_id = ?")
        .bind(token)
        .fetch_optional(&st.db)
        .await?;
    let Some(blob) = blob.filter(|_| !skipped) else {
        sqlx::query("DELETE FROM handovers WHERE token_id = ?").bind(token).execute(&st.db).await?;
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO handovers (token_id, from_addr, to_addr, sealed, key_etag, created_at) VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET from_addr = excluded.from_addr, to_addr = excluded.to_addr,
            sealed = NULL, key_etag = excluded.key_etag, created_at = excluded.created_at
         WHERE NOT (handovers.from_addr = excluded.from_addr AND handovers.to_addr = excluded.to_addr AND handovers.sealed IS NOT NULL)",
    )
    .bind(token)
    .bind(&from)
    .bind(&to)
    .bind(etag(&blob))
    .bind(now())
    .execute(&st.db)
    .await?;
    Ok(())
}
