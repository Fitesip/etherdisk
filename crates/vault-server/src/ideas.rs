//! Ideas board: drive owners propose ideas and vote for them.
//!
//! - Anyone may read; any wallet holding at least one drive may propose.
//! - A vote counts once per NFT: voting "for" records every token the voter holds right
//!   now; "withdraw" removes those. If a token changes hands, its new holder's vote
//!   replaces the old one.
//! - Each vote is a wallet signature over a fixed message (like Snapshot). The server
//!   checks it and keeps it, so anyone can audit the tally via `GET /ideas/{id}/votes`.
//! - The contract owner moderates: sets a status or hides an idea.

use alloy::primitives::{Address, Signature};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::ratelimit;
use crate::{now, AppError, AppResult, AppState};

pub const MAX_TITLE: usize = 120;
pub const MAX_BODY: usize = 2000;
/// How old a signed vote may be.
pub const VOTE_MAX_AGE_SECS: i64 = 600;
pub const STATUSES: [&str; 5] = ["open", "planned", "in_progress", "done", "declined"];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/ideas", get(list).post(create))
        .route("/ideas/me", get(me))
        .route("/ideas/{id}", axum::routing::patch(moderate))
        .route("/ideas/{id}/vote", post(vote))
        .route("/ideas/{id}/votes", get(votes))
}

/// The exact text a voter signs; the client builds the same.
pub fn vote_message(idea: i64, choice: &str, address: &Address, issued_at: i64) -> String {
    format!("NFT Vault vote\n\nIdea: #{idea}\nChoice: {choice}\nAddress: {address:#x}\nIssued at: {issued_at}")
}

fn lower(a: &Address) -> String {
    format!("{a:#x}")
}

#[derive(Serialize, sqlx::FromRow)]
struct Idea {
    id: i64,
    title: String,
    body: String,
    author: String,
    status: String,
    hidden: bool,
    votes: i64,
    created_at: i64,
}

/// Public list, most votes first. Hidden ideas only for the admin.
async fn list(State(st): State<AppState>, user: Option<AuthUser>) -> AppResult<Json<Vec<Idea>>> {
    let admin = match &user {
        Some(u) => st.chain.is_admin(u.0).await?,
        None => false,
    };
    let rows = sqlx::query_as::<_, Idea>(
        "SELECT i.id, i.title, i.body, i.author, i.status, i.hidden, i.created_at,
                (SELECT COUNT(*) FROM idea_votes v WHERE v.idea_id = i.id) AS votes
         FROM ideas i WHERE i.hidden = 0 OR ?
         ORDER BY votes DESC, i.created_at DESC",
    )
    .bind(admin)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize)]
struct Me {
    /// Votes this wallet can cast (one per drive it holds).
    tokens: usize,
    admin: bool,
    /// Ideas this wallet's tokens currently vote for.
    voted: Vec<i64>,
}

async fn me(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Me>> {
    let tokens = st.chain.tokens_of_owner(user.0).await?;
    let ids: Vec<String> = tokens.iter().map(|t| t.to_string()).collect();
    let mut voted: Vec<i64> = Vec::new();
    for id in &ids {
        let rows: Vec<i64> = sqlx::query_scalar("SELECT idea_id FROM idea_votes WHERE token_id = ?").bind(id).fetch_all(&st.db).await?;
        voted.extend(rows);
    }
    voted.sort_unstable();
    voted.dedup();
    Ok(Json(Me { tokens: ids.len(), admin: st.chain.is_admin(user.0).await?, voted }))
}

#[derive(Deserialize)]
struct NewIdea {
    title: String,
    #[serde(default)]
    body: String,
}

async fn create(State(st): State<AppState>, user: AuthUser, Json(req): Json<NewIdea>) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let title = req.title.trim();
    let body = req.body.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.chars().any(char::is_control) {
        return Err(AppError::bad(format!("title must be 1..={MAX_TITLE} characters on one line")));
    }
    if body.chars().count() > MAX_BODY {
        return Err(AppError::bad(format!("description must be at most {MAX_BODY} characters")));
    }
    if st.chain.tokens_of_owner(user.0).await?.is_empty() {
        return Err(AppError::Forbidden);
    }
    if let Err(retry) = st.limiter.check(ratelimit::IDEA_CREATE, &lower(&user.0)) {
        return Err(AppError::RateLimited(retry));
    }
    let t = now();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO ideas (title, body, author, status, hidden, created_at, updated_at) VALUES (?, ?, ?, 'open', 0, ?, ?) RETURNING id",
    )
    .bind(title)
    .bind(body)
    .bind(lower(&user.0))
    .bind(t)
    .bind(t)
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

#[derive(Deserialize)]
struct VoteRequest {
    /// "for" or "withdraw"
    choice: String,
    issued_at: i64,
    /// 0x-hex signature over `vote_message`.
    signature: String,
}

async fn vote(State(st): State<AppState>, user: AuthUser, Path(id): Path<i64>, Json(req): Json<VoteRequest>) -> AppResult<Json<serde_json::Value>> {
    if req.choice != "for" && req.choice != "withdraw" {
        return Err(AppError::bad("choice must be \"for\" or \"withdraw\""));
    }
    if (now() - req.issued_at).abs() > VOTE_MAX_AGE_SECS {
        return Err(AppError::bad("the signed vote is too old; sign again"));
    }
    if let Err(retry) = st.limiter.check(ratelimit::VOTE, &lower(&user.0)) {
        return Err(AppError::RateLimited(retry));
    }
    let message = vote_message(id, &req.choice, &user.0, req.issued_at);
    let sig_bytes = alloy::hex::decode(&req.signature).map_err(|_| AppError::bad("malformed signature"))?;
    let sig = Signature::try_from(sig_bytes.as_slice()).map_err(|_| AppError::bad("malformed signature"))?;
    if sig.recover_address_from_msg(&message).map_err(|_| AppError::bad("invalid signature"))? != user.0 {
        return Err(AppError::bad("the signature is not from this wallet"));
    }
    let visible: Option<bool> = sqlx::query_scalar("SELECT hidden FROM ideas WHERE id = ?").bind(id).fetch_optional(&st.db).await?;
    if visible != Some(false) {
        return Err(AppError::NotFound);
    }
    let tokens = st.chain.tokens_of_owner(user.0).await?;
    if tokens.is_empty() {
        return Err(AppError::Forbidden);
    }

    let mut tx = st.db.begin().await?;
    for token in &tokens {
        let token = token.to_string();
        if req.choice == "for" {
            sqlx::query(
                "INSERT INTO idea_votes (idea_id, token_id, voter, message, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (idea_id, token_id) DO UPDATE SET voter = excluded.voter, message = excluded.message,
                    signature = excluded.signature, created_at = excluded.created_at",
            )
            .bind(id)
            .bind(&token)
            .bind(lower(&user.0))
            .bind(&message)
            .bind(&req.signature)
            .bind(now())
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("DELETE FROM idea_votes WHERE idea_id = ? AND token_id = ?").bind(id).bind(&token).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    let votes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM idea_votes WHERE idea_id = ?").bind(id).fetch_one(&st.db).await?;
    Ok(Json(serde_json::json!({ "votes": votes })))
}

#[derive(Serialize, sqlx::FromRow)]
struct VoteRecord {
    token_id: String,
    voter: String,
    message: String,
    signature: String,
    created_at: i64,
}

/// Every vote with its signed message, for anyone to verify.
async fn votes(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<Vec<VoteRecord>>> {
    let rows = sqlx::query_as::<_, VoteRecord>(
        "SELECT v.token_id, v.voter, v.message, v.signature, v.created_at FROM idea_votes v JOIN ideas i ON i.id = v.idea_id
         WHERE v.idea_id = ? AND i.hidden = 0 ORDER BY v.created_at",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct Moderate {
    status: Option<String>,
    hidden: Option<bool>,
}

/// Admin only: set a status ("planned", "done", ...) or hide/unhide.
async fn moderate(State(st): State<AppState>, user: AuthUser, Path(id): Path<i64>, Json(req): Json<Moderate>) -> AppResult<StatusCode> {
    if !st.chain.is_admin(user.0).await? {
        return Err(AppError::Forbidden);
    }
    if let Some(s) = &req.status {
        if !STATUSES.contains(&s.as_str()) {
            return Err(AppError::bad(format!("status must be one of {STATUSES:?}")));
        }
    }
    let n = sqlx::query("UPDATE ideas SET status = COALESCE(?, status), hidden = COALESCE(?, hidden), updated_at = ? WHERE id = ?")
        .bind(&req.status)
        .bind(req.hidden)
        .bind(now())
        .bind(id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
