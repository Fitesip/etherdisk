//! Files and folders of a vault: tree, uploads, downloads.
//!
//! Upload flow (the browser encrypts while reading the file):
//!   1. `POST /files` declares the encrypted sizes; quota is reserved, the file is `pending`.
//!   2. `PUT /files/{id}/content?offset=N` appends parts in order. A failed part is rolled
//!      back entirely, so the client just retries it.
//!   3. `PUT /files/{id}/thumbnail` (optional, images/video).
//!   4. `POST /files/{id}/complete` checks sizes and headers, the file becomes `ready`.
//!
//! Pending files that are never completed are removed by the cleanup task.

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::range::serve_blob;
use crate::storage::{content_key, read_to_vec, thumb_key, AppendError};
use crate::vaults::owned;
use crate::{b64, now, AppError, AppResult, AppState};

pub const MAX_METADATA: usize = 4 * 1024;
pub const MAX_THUMBNAIL: u64 = 2 * 1024 * 1024;
/// Pending uploads older than this are deleted.
pub const PENDING_TTL_SECS: i64 = 24 * 3600;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/vaults/{token_id}/objects", get(list))
        .route("/vaults/{token_id}/folders", post(create_folder))
        .route("/vaults/{token_id}/files", post(create_file))
        .route(
            "/vaults/{token_id}/files/{id}/content",
            put(put_content).get(get_content).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/vaults/{token_id}/files/{id}/thumbnail",
            put(put_thumbnail).get(get_thumbnail).layer(DefaultBodyLimit::max(MAX_THUMBNAIL as usize)),
        )
        .route("/vaults/{token_id}/files/{id}/complete", post(complete))
        .route("/vaults/{token_id}/objects/{id}", delete(remove))
        .route("/vaults/{token_id}/objects/{id}/metadata", put(set_metadata))
        .route("/vaults/{token_id}/objects/{id}/move", post(move_object))
        .route("/vaults/{token_id}/objects/{id}/path", get(path))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Object {
    id: String,
    parent_id: Option<String>,
    /// "file" | "folder"
    kind: String,
    /// Sealed with the vault metadata key (name, MIME type, plaintext size, ...).
    #[serde(with = "b64")]
    metadata: Vec<u8>,
    /// Encrypted size in bytes (0 for folders).
    size: i64,
    thumb_size: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct ListQuery {
    /// Folder to list; absent = vault root.
    parent: Option<Uuid>,
}

async fn list(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Object>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let parent = q.parent.map(|p| p.to_string());
    if let Some(p) = &q.parent {
        ensure_folder(&st, &token, p).await?;
    }
    let rows = sqlx::query_as::<_, Object>(
        "SELECT id, parent_id, kind, metadata, size, thumb_size, created_at, updated_at FROM objects
         WHERE token_id = ? AND parent_id IS ? AND status = 'ready' ORDER BY kind DESC, created_at",
    )
    .bind(&token)
    .bind(parent)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

/// The object and its ancestors, root first (to rebuild breadcrumbs from a folder id in the URL).
async fn path(State(st): State<AppState>, user: AuthUser, Path((token_id, id)): Path<(String, Uuid)>) -> AppResult<Json<Vec<Object>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let rows = sqlx::query_as::<_, Object>(
        "WITH RECURSIVE up(id, depth) AS (
            SELECT id, 0 FROM objects WHERE id = ? AND token_id = ?
            UNION ALL SELECT o.parent_id, up.depth + 1 FROM objects o JOIN up ON o.id = up.id WHERE o.parent_id IS NOT NULL
         ) SELECT o.id, o.parent_id, o.kind, o.metadata, o.size, o.thumb_size, o.created_at, o.updated_at
           FROM objects o JOIN up USING (id) ORDER BY up.depth DESC",
    )
    .bind(id.to_string())
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    if rows.is_empty() {
        return Err(AppError::NotFound);
    }
    Ok(Json(rows))
}

async fn ensure_folder(st: &AppState, token: &str, id: &Uuid) -> AppResult<()> {
    let found: Option<String> = sqlx::query_scalar("SELECT kind FROM objects WHERE id = ? AND token_id = ?")
        .bind(id.to_string())
        .bind(token)
        .fetch_optional(&st.db)
        .await?;
    match found.as_deref() {
        Some("folder") => Ok(()),
        Some(_) => Err(AppError::bad("parent is not a folder")),
        None => Err(AppError::bad("parent folder not found")),
    }
}

fn check_metadata(m: &[u8]) -> AppResult<()> {
    if m.is_empty() || m.len() > MAX_METADATA {
        return Err(AppError::bad(format!("metadata must be 1..={MAX_METADATA} bytes")));
    }
    Ok(())
}

fn map_insert_err(e: sqlx::Error) -> AppError {
    match e.as_database_error() {
        Some(d) if d.is_unique_violation() => AppError::conflict("object id already exists"),
        _ => e.into(),
    }
}

#[derive(Deserialize)]
struct CreateFolder {
    /// Chosen by the client because it is bound into the metadata AAD.
    id: Uuid,
    parent_id: Option<Uuid>,
    #[serde(with = "b64")]
    metadata: Vec<u8>,
}

#[derive(Serialize)]
struct Created {
    id: Uuid,
}

async fn create_folder(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<CreateFolder>,
) -> AppResult<(StatusCode, Json<Created>)> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    check_metadata(&req.metadata)?;
    if let Some(p) = &req.parent_id {
        ensure_folder(&st, &token, p).await?;
    }
    let t = now();
    sqlx::query(
        "INSERT INTO objects (id, token_id, parent_id, kind, metadata, status, created_at, updated_at)
         VALUES (?, ?, ?, 'folder', ?, 'ready', ?, ?)",
    )
    .bind(req.id.to_string())
    .bind(&token)
    .bind(req.parent_id.map(|p| p.to_string()))
    .bind(&req.metadata)
    .bind(t)
    .bind(t)
    .execute(&st.db)
    .await
    .map_err(map_insert_err)?;
    Ok((StatusCode::CREATED, Json(Created { id: req.id })))
}

#[derive(Deserialize)]
struct CreateFile {
    id: Uuid,
    parent_id: Option<Uuid>,
    #[serde(with = "b64")]
    metadata: Vec<u8>,
    /// Encrypted size (`encryptedLen(plainSize, chunkSize)` on the client).
    size: u64,
    /// Encrypted thumbnail size, if the client will upload one.
    thumb_size: Option<u64>,
}

async fn create_file(
    State(st): State<AppState>,
    user: AuthUser,
    Path(token_id): Path<String>,
    Json(req): Json<CreateFile>,
) -> AppResult<(StatusCode, Json<Created>)> {
    let (id, token) = owned(&st, &user, &token_id).await?;
    check_metadata(&req.metadata)?;
    let min = (vault_crypto::HEADER_LEN + vault_crypto::TAG_LEN) as u64;
    if req.size < min || req.size > i64::MAX as u64 {
        return Err(AppError::bad("invalid size"));
    }
    if let Some(ts) = req.thumb_size {
        if ts < min || ts > MAX_THUMBNAIL {
            return Err(AppError::bad(format!("thumbnail must be {min}..={MAX_THUMBNAIL} bytes")));
        }
    }
    if let Some(p) = &req.parent_id {
        ensure_folder(&st, &token, p).await?;
    }
    let capacity = st.chain.capacity_bytes(id).await?;
    let needed = req.size + req.thumb_size.unwrap_or(0);

    // Check-and-reserve in one statement so concurrent uploads cannot overshoot the quota.
    let t = now();
    let inserted = sqlx::query(
        "INSERT INTO objects (id, token_id, parent_id, kind, metadata, size, thumb_size, status, created_at, updated_at)
         SELECT ?, ?, ?, 'file', ?, ?, ?, 'pending', ?, ?
         WHERE (SELECT COALESCE(SUM(size + COALESCE(thumb_size, 0)), 0) FROM objects WHERE token_id = ?) + ? <= ?",
    )
    .bind(req.id.to_string())
    .bind(&token)
    .bind(req.parent_id.map(|p| p.to_string()))
    .bind(&req.metadata)
    .bind(req.size as i64)
    .bind(req.thumb_size.map(|s| s as i64))
    .bind(t)
    .bind(t)
    .bind(&token)
    .bind(needed as i64)
    .bind(capacity as i64)
    .execute(&st.db)
    .await
    .map_err(map_insert_err)?
    .rows_affected();
    if inserted == 0 {
        return Err(AppError::QuotaExceeded);
    }
    Ok((StatusCode::CREATED, Json(Created { id: req.id })))
}

struct FileRow {
    size: u64,
    thumb_size: Option<u64>,
}

async fn file_row(st: &AppState, token: &str, id: &Uuid, status: &str) -> AppResult<FileRow> {
    let row: Option<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT size, thumb_size FROM objects WHERE id = ? AND token_id = ? AND kind = 'file' AND status = ?",
    )
    .bind(id.to_string())
    .bind(token)
    .bind(status)
    .fetch_optional(&st.db)
    .await?;
    let (size, thumb) = row.ok_or(AppError::NotFound)?;
    Ok(FileRow { size: size as u64, thumb_size: thumb.map(|t| t as u64) })
}

#[derive(Deserialize)]
struct OffsetQuery {
    offset: u64,
}

#[derive(Serialize)]
struct Received {
    received: u64,
}

async fn put_content(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    Query(q): Query<OffsetQuery>,
    body: Body,
) -> AppResult<Json<Received>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "pending").await?;
    let _guard = st.lock_upload(id).ok_or_else(|| AppError::conflict("another upload to this file is in progress"))?;

    let key = content_key(&token, &id);
    let current = st.store.size(&key).await?.unwrap_or(0);
    if q.offset != current {
        return Err(AppError::conflict(format!("expected offset {current}")));
    }
    let stream = body.into_data_stream().map_err(std::io::Error::other).boxed();
    let received = st.store.append(&key, stream, file.size - current).await.map_err(|e| match e {
        AppendError::TooLarge => AppError::bad("upload exceeds the declared size"),
        AppendError::Io(e) => e.into(),
    })?;
    Ok(Json(Received { received }))
}

async fn put_thumbnail(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    body: Bytes,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "pending").await?;
    if file.thumb_size != Some(body.len() as u64) {
        return Err(AppError::bad("thumbnail size does not match the declared size"));
    }
    st.store.put(&thumb_key(&token, &id), body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Rejects blobs that are not well-formed vault-crypto files of exactly `size` bytes.
async fn check_encrypted(st: &AppState, key: &str, size: u64) -> AppResult<()> {
    let invalid = || AppError::bad("uploaded data is not a valid encrypted file");
    if st.store.size(key).await? != Some(size) {
        return Err(AppError::bad("upload is incomplete"));
    }
    let head = read_to_vec(st.store.as_ref(), key, 0, vault_crypto::HEADER_LEN as u64).await?;
    let header = vault_crypto::FileHeader::parse(&head).map_err(|_| invalid())?;
    vault_crypto::plaintext_len(size, header.chunk_size).map_err(|_| invalid())?;
    Ok(())
}

async fn complete(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "pending").await?;
    let _guard = st.lock_upload(id).ok_or_else(|| AppError::conflict("an upload to this file is in progress"))?;

    check_encrypted(&st, &content_key(&token, &id), file.size).await?;
    if let Some(ts) = file.thumb_size {
        check_encrypted(&st, &thumb_key(&token, &id), ts).await?;
    }
    sqlx::query("UPDATE objects SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'pending'")
        .bind(now())
        .bind(id.to_string())
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_content(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "ready").await?;
    serve_blob(st.store.as_ref(), &content_key(&token, &id), file.size, &headers).await
}

async fn get_thumbnail(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "ready").await?;
    let size = file.thumb_size.ok_or(AppError::NotFound)?;
    serve_blob(st.store.as_ref(), &thumb_key(&token, &id), size, &headers).await
}

#[derive(Deserialize)]
struct MetadataRequest {
    #[serde(with = "b64")]
    metadata: Vec<u8>,
}

/// Rename etc.: the client re-seals the metadata and replaces it.
async fn set_metadata(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    Json(req): Json<MetadataRequest>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    check_metadata(&req.metadata)?;
    let n = sqlx::query("UPDATE objects SET metadata = ?, updated_at = ? WHERE id = ? AND token_id = ?")
        .bind(&req.metadata)
        .bind(now())
        .bind(id.to_string())
        .bind(&token)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MoveRequest {
    /// `null` = move to the vault root.
    parent_id: Option<Uuid>,
}

async fn move_object(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
    Json(req): Json<MoveRequest>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    if let Some(p) = &req.parent_id {
        ensure_folder(&st, &token, p).await?;
        // The target must not be the object itself or anything inside it.
        let cycle: bool = sqlx::query_scalar(
            "WITH RECURSIVE up(id, parent_id) AS (
                SELECT id, parent_id FROM objects WHERE id = ?
                UNION ALL SELECT o.id, o.parent_id FROM objects o JOIN up ON o.id = up.parent_id
             ) SELECT EXISTS (SELECT 1 FROM up WHERE id = ?)",
        )
        .bind(p.to_string())
        .bind(id.to_string())
        .fetch_one(&st.db)
        .await?;
        if cycle {
            return Err(AppError::bad("cannot move a folder into itself"));
        }
    }
    let n = sqlx::query("UPDATE objects SET parent_id = ?, updated_at = ? WHERE id = ? AND token_id = ?")
        .bind(req.parent_id.map(|p| p.to_string()))
        .bind(now())
        .bind(id.to_string())
        .bind(&token)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes a file, or a folder with everything inside it. Also cancels pending uploads.
async fn remove(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    delete_subtree(&st, &token, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn delete_subtree(st: &AppState, token: &str, id: &Uuid) -> AppResult<()> {
    let mut tx = st.db.begin().await?;
    let files: Vec<(String, Option<i64>)> = sqlx::query_as(
        "WITH RECURSIVE sub(id) AS (
            SELECT id FROM objects WHERE id = ? AND token_id = ?
            UNION ALL SELECT o.id FROM objects o JOIN sub ON o.parent_id = sub.id
         ) SELECT o.id, o.thumb_size FROM objects o JOIN sub USING (id) WHERE o.kind = 'file'",
    )
    .bind(id.to_string())
    .bind(token)
    .fetch_all(&mut *tx)
    .await?;
    // Children and share_objects rows go via ON DELETE CASCADE.
    let n = sqlx::query("DELETE FROM objects WHERE id = ? AND token_id = ?")
        .bind(id.to_string())
        .bind(token)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    // Links that no longer point at anything.
    sqlx::query("DELETE FROM shares WHERE token_id = ? AND NOT EXISTS (SELECT 1 FROM share_objects WHERE share_id = shares.id)")
        .bind(token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    for (file_id, thumb) in files {
        let file_id: Uuid = file_id.parse().map_err(anyhow::Error::from)?;
        st.store.delete(&content_key(token, &file_id)).await?;
        if thumb.is_some() {
            st.store.delete(&thumb_key(token, &file_id)).await?;
        }
    }
    Ok(())
}

/// Removes uploads that were started but never completed. Returns how many.
pub async fn cleanup_pending(st: &AppState) -> AppResult<usize> {
    let stale: Vec<(String, String)> =
        sqlx::query_as("SELECT id, token_id FROM objects WHERE status = 'pending' AND created_at < ?")
            .bind(now() - PENDING_TTL_SECS)
            .fetch_all(&st.db)
            .await?;
    let n = stale.len();
    for (id, token) in stale {
        let id: Uuid = id.parse().map_err(anyhow::Error::from)?;
        match delete_subtree(st, &token, &id).await {
            Ok(()) | Err(AppError::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

