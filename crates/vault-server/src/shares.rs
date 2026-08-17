//! Public links to files and folders.
//!
//! The link is `/s/{share_id}#{share_key}`. The fragment never reaches the server; the
//! key decrypts `manifest`, which the owner's browser built with the names and per-file
//! keys of the shared files. The server only knows which object ids the link unlocks.
//! A folder link is a snapshot: files added to the folder later are not included.
//!
//! Links die when the token changes owner: the indexer deletes them on `Transfer`, and
//! every access re-checks the current owner in case the indexer is behind.

use std::collections::BTreeSet;

use alloy::primitives::Address;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::objects::MAX_METADATA;
use crate::range::serve_blob;
use crate::storage::{content_key, thumb_key};
use crate::vaults::{owned, parse_token};
use crate::{b64, now, random_hex, AppError, AppResult, AppState};

pub const MAX_MANIFEST: usize = 8 * 1024 * 1024;
pub const MAX_SHARE_FILES: usize = 10_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/vaults/{token_id}/shares",
            post(create).get(list).layer(DefaultBodyLimit::max(MAX_MANIFEST * 2)),
        )
        .route("/vaults/{token_id}/shares/{share_id}", delete(revoke))
        .route("/shares/{share_id}", get(open))
        .route("/shares/{share_id}/files/{id}/content", get(content))
        .route("/shares/{share_id}/files/{id}/thumbnail", get(thumbnail))
}

#[derive(Deserialize)]
struct CreateShare {
    /// Files the link unlocks (for a folder: every file inside it).
    object_ids: Vec<Uuid>,
    /// Encrypted with the link key.
    #[serde(with = "b64")]
    manifest: Vec<u8>,
    /// Sealed with the vault metadata key: lets the owner list links and copy them again.
    #[serde(with = "b64")]
    owner_metadata: Vec<u8>,
}

#[derive(Serialize)]
struct Created {
    id: String,
}

async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<CreateShare>,
) -> AppResult<(StatusCode, Json<Created>)> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let ids: BTreeSet<Uuid> = req.object_ids.into_iter().collect();
    if ids.is_empty() || ids.len() > MAX_SHARE_FILES {
        return Err(AppError::bad(format!("a link must cover 1..={MAX_SHARE_FILES} files")));
    }
    if req.manifest.is_empty() || req.manifest.len() > MAX_MANIFEST {
        return Err(AppError::bad("invalid manifest size"));
    }
    if req.owner_metadata.is_empty() || req.owner_metadata.len() > MAX_METADATA {
        return Err(AppError::bad("invalid owner_metadata size"));
    }

    let id = random_hex(16);
    let mut tx = st.db.begin().await?;
    sqlx::query("INSERT INTO shares (id, token_id, owner, manifest, owner_metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&token)
        .bind(user.0.to_string().to_lowercase())
        .bind(&req.manifest)
        .bind(&req.owner_metadata)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    for object_id in ids {
        let n = sqlx::query(
            "INSERT INTO share_objects (share_id, object_id)
             SELECT ?, id FROM objects WHERE id = ? AND token_id = ? AND kind = 'file' AND status = 'ready'",
        )
        .bind(&id)
        .bind(object_id.to_string())
        .bind(&token)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(AppError::bad(format!("{object_id} is not a file in this vault")));
        }
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(Created { id })))
}

#[derive(Serialize, sqlx::FromRow)]
struct ShareInfo {
    id: String,
    #[serde(with = "b64")]
    owner_metadata: Vec<u8>,
    file_count: i64,
    created_at: i64,
}

async fn list(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Vec<ShareInfo>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let rows = sqlx::query_as::<_, ShareInfo>(
        "SELECT s.id, s.owner_metadata, s.created_at,
                (SELECT COUNT(*) FROM share_objects so WHERE so.share_id = s.id) AS file_count
         FROM shares s WHERE s.token_id = ? ORDER BY s.created_at DESC",
    )
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

async fn revoke(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, share_id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let n = sqlx::query("DELETE FROM shares WHERE id = ? AND token_id = ?")
        .bind(&share_id)
        .bind(&token)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes all links of a token (called when it changes owner).
pub async fn revoke_all(st: &AppState, token: &str) -> AppResult<u64> {
    Ok(sqlx::query("DELETE FROM shares WHERE token_id = ?").bind(token).execute(&st.db).await?.rows_affected())
}

/// Returns the share's token if the link is still valid.
async fn live_share(st: &AppState, share_id: &str) -> AppResult<String> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT token_id, owner FROM shares WHERE id = ?")
        .bind(share_id)
        .fetch_optional(&st.db)
        .await?;
    let (token, owner) = row.ok_or(AppError::NotFound)?;
    let creator: Address = owner.parse().map_err(|e| anyhow::anyhow!("bad stored address: {e}"))?;
    if st.chain.owner_of(parse_token(&token)?).await? != Some(creator) {
        revoke_all(st, &token).await?;
        return Err(AppError::NotFound);
    }
    Ok(token)
}

#[derive(Serialize)]
struct OpenResponse {
    #[serde(with = "b64")]
    manifest: Vec<u8>,
}

async fn open(State(st): State<AppState>, Path(share_id): Path<String>) -> AppResult<Json<OpenResponse>> {
    live_share(&st, &share_id).await?;
    let manifest: Vec<u8> = sqlx::query_scalar("SELECT manifest FROM shares WHERE id = ?")
        .bind(&share_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(OpenResponse { manifest }))
}

/// Sizes of a file the share unlocks.
async fn shared_file(st: &AppState, share_id: &str, id: &Uuid) -> AppResult<(String, i64, Option<i64>)> {
    let token = live_share(st, share_id).await?;
    let row: Option<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT o.size, o.thumb_size FROM share_objects so JOIN objects o ON o.id = so.object_id
         WHERE so.share_id = ? AND o.id = ? AND o.status = 'ready'",
    )
    .bind(share_id)
    .bind(id.to_string())
    .fetch_optional(&st.db)
    .await?;
    let (size, thumb) = row.ok_or(AppError::NotFound)?;
    Ok((token, size, thumb))
}

async fn content(
    State(st): State<AppState>,
    Path((share_id, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (token, size, _) = shared_file(&st, &share_id, &id).await?;
    serve_blob(st.store.as_ref(), &content_key(&token, &id), size as u64, &headers).await
}

async fn thumbnail(
    State(st): State<AppState>,
    Path((share_id, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (token, _, thumb) = shared_file(&st, &share_id, &id).await?;
    let size = thumb.ok_or(AppError::NotFound)?;
    serve_blob(st.store.as_ref(), &thumb_key(&token, &id), size as u64, &headers).await
}
