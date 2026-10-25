//! Drives put up for sale. The owner says whether the buyer gets the drive's key (and so
//! can open its files) or an empty drive to format; anyone can look this up, with how much
//! of the drive is used, at `GET /nft/{id}` (the site's page for the NFT, linked from the
//! marketplaces). The NFT itself doesn't change: the contract's metadata is fixed.
//!
//! - The key is a promise: the buyer is unknown until the sale, so it can't be sealed to
//!   them beforehand. After the transfer the seller's app asks for it (handover.rs).
//! - Selling without the key: the transfer doesn't ask the seller for it.
//! - Any transfer ends the listing; a listing by a former owner is ignored and dropped.

use alloy::primitives::{Address, U256};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::vaults::{owned, parse_token, used_bytes};
use crate::{now, AppError, AppResult, AppState};

/// Routes for the drive's owner.
pub fn routes() -> Router<AppState> {
    Router::new().route("/vaults/{token_id}/sale", put(list).delete(unlist))
}

/// The public page's data: no session needed.
pub fn public_routes() -> Router<AppState> {
    Router::new().route("/nft/{token_id}", get(public))
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
pub struct Sale {
    /// The buyer gets the drive's key (the files can be opened).
    pub with_key: bool,
    pub since: i64,
}

#[derive(Deserialize)]
struct ListRequest {
    with_key: bool,
}

/// The token's listing, if its current owner `owner` made it.
pub async fn sale_of(st: &AppState, token: &str, owner: Address) -> AppResult<Option<Sale>> {
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT with_key, created_at FROM sales WHERE token_id = ? AND owner = ?")
        .bind(token)
        .bind(format!("{owner:#x}"))
        .fetch_optional(&st.db)
        .await?;
    Ok(row.map(|(with_key, since)| Sale { with_key: with_key != 0, since }))
}

async fn initialized(st: &AppState, token: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM vault_keys WHERE token_id = ?)").bind(token).fetch_one(&st.db).await?)
}

async fn list(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>, Json(req): Json<ListRequest>) -> AppResult<Json<Sale>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    if req.with_key && !initialized(&st, &token).await? {
        return Err(AppError::conflict("the drive is not set up: it has no key to hand over"));
    }
    let since = now();
    sqlx::query(
        "INSERT INTO sales (token_id, owner, with_key, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token_id) DO UPDATE SET owner = excluded.owner, with_key = excluded.with_key, created_at = excluded.created_at",
    )
    .bind(&token)
    .bind(format!("{:#x}", user.0))
    .bind(req.with_key as i64)
    .bind(since)
    .execute(&st.db)
    .await?;
    Ok(Json(Sale { with_key: req.with_key, since }))
}

async fn unlist(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    sqlx::query("DELETE FROM sales WHERE token_id = ?").bind(&token).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Public {
    token_id: String,
    capacity_bytes: u64,
    /// Only while for sale: the owner shows the drive's state to buyers.
    #[serde(skip_serializing_if = "Option::is_none")]
    sale: Option<PublicSale>,
}

#[derive(Serialize)]
struct PublicSale {
    with_key: bool,
    since: i64,
    used_bytes: u64,
    /// Whether the drive was ever set up (has a key and so may hold files).
    initialized: bool,
}

async fn public(State(st): State<AppState>, Path(token_id): Path<String>) -> AppResult<Json<Public>> {
    let id: U256 = parse_token(&token_id)?;
    let owner = st.chain.owner_of(id).await?.ok_or(AppError::NotFound)?;
    let token = id.to_string();
    let sale = match sale_of(&st, &token, owner).await? {
        Some(s) => Some(PublicSale { with_key: s.with_key, since: s.since, used_bytes: used_bytes(&st, &token).await?, initialized: initialized(&st, &token).await? }),
        None => {
            // Made by a former owner (the indexer missed the transfer): no longer true.
            sqlx::query("DELETE FROM sales WHERE token_id = ?").bind(&token).execute(&st.db).await?;
            None
        }
    };
    Ok(Json(Public { token_id: token, capacity_bytes: st.chain.capacity_bytes(id).await?, sale }))
}

/// Indexer hook: the transfer ends the listing; returns it as it was.
pub async fn on_transfer(st: &AppState, from: Address, token: &str) -> AppResult<Option<Sale>> {
    let sale = sale_of(st, token, from).await?;
    sqlx::query("DELETE FROM sales WHERE token_id = ?").bind(token).execute(&st.db).await?;
    Ok(sale)
}
