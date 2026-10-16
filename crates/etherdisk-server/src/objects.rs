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
//!
//! Deleting moves an object to the trash (`trashed_at`); everything inside a trashed
//! folder is hidden with it. The trash is purged after `TRASH_TTL_SECS`.

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
/// Trashed objects older than this are deleted for good.
pub const TRASH_TTL_SECS: i64 = 30 * 24 * 3600;

const COLUMNS: &str = "id, parent_id, kind, metadata, size, thumb_size, created_at, updated_at, trashed_at";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/vaults/{token_id}/objects", get(list))
        .route("/vaults/{token_id}/objects/all", get(list_all))
        .route("/vaults/{token_id}/trash", get(list_trash))
        .route("/vaults/{token_id}/trash/empty", post(empty_trash))
        .route("/vaults/{token_id}/uploads", get(list_uploads))
        .route("/vaults/{token_id}/folders", post(create_folder))
        .route("/vaults/{token_id}/files", post(create_file))
        .route(
            "/vaults/{token_id}/files/{id}/content",
            put(put_content).get(get_content).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/vaults/{token_id}/files/{id}/thumbnail",
            put(put_thumbnail).get(get_thumbnail).delete(drop_thumbnail).layer(DefaultBodyLimit::max(MAX_THUMBNAIL as usize)),
        )
        .route("/vaults/{token_id}/files/{id}/complete", post(complete))
        .route("/vaults/{token_id}/objects/{id}", delete(remove))
        .route("/vaults/{token_id}/objects/{id}/metadata", put(set_metadata))
        .route("/vaults/{token_id}/objects/{id}/move", post(move_object))
        .route("/vaults/{token_id}/objects/{id}/path", get(path))
        .route("/vaults/{token_id}/objects/{id}/restore", post(restore))
        .route("/vaults/{token_id}/objects/{id}/permanent", delete(remove_permanent))
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
    /// Set while in the trash.
    trashed_at: Option<i64>,
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
    let rows = sqlx::query_as::<_, Object>(&format!(
        "SELECT {COLUMNS} FROM objects
         WHERE token_id = ? AND parent_id IS ? AND status = 'ready' AND trashed_at IS NULL ORDER BY kind DESC, created_at"
    ))
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
         ) SELECT o.id, o.parent_id, o.kind, o.metadata, o.size, o.thumb_size, o.created_at, o.updated_at, o.trashed_at
           FROM objects o JOIN up USING (id) ORDER BY up.depth DESC",
    )
    .bind(id.to_string())
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    if rows.is_empty() || rows.iter().any(|r| r.trashed_at.is_some()) {
        return Err(AppError::NotFound);
    }
    Ok(Json(rows))
}

/// Every live (ready, not trashed) object of the vault, for client-side search:
/// names are encrypted, so the browser decrypts and filters them.
async fn list_all(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Vec<Object>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let rows = sqlx::query_as::<_, Object>(
        "WITH RECURSIVE live(id) AS (
            SELECT id FROM objects WHERE token_id = ? AND parent_id IS NULL AND status = 'ready' AND trashed_at IS NULL
            UNION ALL SELECT o.id FROM objects o JOIN live ON o.parent_id = live.id
                      WHERE o.status = 'ready' AND o.trashed_at IS NULL
         ) SELECT o.id, o.parent_id, o.kind, o.metadata, o.size, o.thumb_size, o.created_at, o.updated_at, o.trashed_at
           FROM objects o JOIN live USING (id)",
    )
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

/// Whether the object or any folder above it is in the trash.
pub(crate) async fn in_trash(st: &AppState, id: &Uuid) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE up(id, parent_id, trashed_at) AS (
            SELECT id, parent_id, trashed_at FROM objects WHERE id = ?
            UNION ALL SELECT o.id, o.parent_id, o.trashed_at FROM objects o JOIN up ON o.id = up.parent_id
         ) SELECT EXISTS (SELECT 1 FROM up WHERE trashed_at IS NOT NULL)",
    )
    .bind(id.to_string())
    .fetch_one(&st.db)
    .await?)
}

async fn ensure_folder(st: &AppState, token: &str, id: &Uuid) -> AppResult<()> {
    let found: Option<String> = sqlx::query_scalar("SELECT kind FROM objects WHERE id = ? AND token_id = ?")
        .bind(id.to_string())
        .bind(token)
        .fetch_optional(&st.db)
        .await?;
    match found.as_deref() {
        Some("folder") if in_trash(st, id).await? => Err(AppError::bad("parent folder not found")),
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
    let min = (etherdisk_crypto::HEADER_LEN + etherdisk_crypto::TAG_LEN) as u64;
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
    let capacity = crate::reserve::usable_capacity(&st, id, &token).await?;
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
        return Err(crate::reserve::too_big(&st, id, capacity).await);
    }
    // Hand the upload's bytes over from the drive's reservation before they arrive.
    crate::reserve::sync_logged(&st, &token).await;
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
    let (vault, token) = owned(&st, &user, &token_id).await?;
    let file = file_row(&st, &token, &id, "pending").await?;
    let size = body.len() as u64;
    let min = (etherdisk_crypto::HEADER_LEN + etherdisk_crypto::TAG_LEN) as u64;
    if size < min || size > MAX_THUMBNAIL {
        return Err(AppError::bad(format!("thumbnail must be {min}..={MAX_THUMBNAIL} bytes")));
    }
    // A resumed upload makes a fresh thumbnail, whose size may differ: re-reserve quota.
    if file.thumb_size != Some(size) {
        let capacity = crate::reserve::usable_capacity(&st, vault, &token).await?;
        let n = sqlx::query(
            "UPDATE objects SET thumb_size = ? WHERE id = ? AND status = 'pending'
               AND (SELECT COALESCE(SUM(size + COALESCE(thumb_size, 0)), 0) FROM objects WHERE token_id = ? AND id != ?)
                   + size + ? <= ?",
        )
        .bind(size as i64)
        .bind(id.to_string())
        .bind(&token)
        .bind(id.to_string())
        .bind(size as i64)
        .bind(capacity as i64)
        .execute(&st.db)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(crate::reserve::too_big(&st, vault, capacity).await);
        }
        crate::reserve::sync_logged(&st, &token).await;
    }
    st.store.put(&thumb_key(&token, &id), body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A pending upload gives up its thumbnail (e.g. it can't be regenerated on resume).
async fn drop_thumbnail(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    file_row(&st, &token, &id, "pending").await?;
    sqlx::query("UPDATE objects SET thumb_size = NULL WHERE id = ? AND status = 'pending'")
        .bind(id.to_string())
        .execute(&st.db)
        .await?;
    st.store.delete(&thumb_key(&token, &id)).await?;
    crate::reserve::sync_logged(&st, &token).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Rejects blobs that are not well-formed etherdisk-crypto files of exactly `size` bytes.
async fn check_encrypted(st: &AppState, key: &str, size: u64) -> AppResult<()> {
    let invalid = || AppError::bad("uploaded data is not a valid encrypted file");
    if st.store.size(key).await? != Some(size) {
        return Err(AppError::bad("upload is incomplete"));
    }
    let head = read_to_vec(st.store.as_ref(), key, 0, etherdisk_crypto::HEADER_LEN as u64).await?;
    let header = etherdisk_crypto::FileHeader::parse(&head).map_err(|_| invalid())?;
    etherdisk_crypto::plaintext_len(size, header.chunk_size).map_err(|_| invalid())?;
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
    // Pending files too: resuming an upload re-checks the last stored chunk. Only the
    // bytes received so far are served.
    let key = content_key(&token, &id);
    let size = match file_row(&st, &token, &id, "ready").await {
        Ok(file) => file.size,
        Err(AppError::NotFound) => {
            file_row(&st, &token, &id, "pending").await?;
            match st.store.size(&key).await? {
                Some(n) if n > 0 => n,
                _ => return Err(AppError::NotFound),
            }
        }
        Err(e) => return Err(e),
    };
    serve_blob(st.store.as_ref(), &key, size, &headers).await
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
    if in_trash(&st, &id).await? {
        return Err(AppError::bad("restore the object from the trash first"));
    }
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

/// Moves a file or folder to the trash. A pending upload is cancelled (deleted) instead.
async fn remove(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM objects WHERE id = ? AND token_id = ?")
        .bind(id.to_string())
        .bind(&token)
        .fetch_optional(&st.db)
        .await?;
    match status.as_deref() {
        None => Err(AppError::NotFound),
        Some("pending") => {
            delete_subtree(&st, &token, &id).await?;
            Ok(StatusCode::NO_CONTENT)
        }
        Some(_) => {
            sqlx::query("UPDATE objects SET trashed_at = ? WHERE id = ? AND token_id = ? AND trashed_at IS NULL")
                .bind(now())
                .bind(id.to_string())
                .bind(&token)
                .execute(&st.db)
                .await?;
            Ok(StatusCode::NO_CONTENT)
        }
    }
}

/// Deletes for good: the object and, for a folder, everything inside it.
async fn remove_permanent(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    delete_subtree(&st, &token, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Takes an object out of the trash. If its folder is (still) trashed, it goes to the root.
async fn restore(
    State(st): State<AppState>,
    user: AuthUser,
    Path((token_id, id)): Path<(String, Uuid)>,
) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let row: Option<(Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT parent_id, trashed_at FROM objects WHERE id = ? AND token_id = ?")
            .bind(id.to_string())
            .bind(&token)
            .fetch_optional(&st.db)
            .await?;
    let (parent, trashed) = row.ok_or(AppError::NotFound)?;
    if trashed.is_none() {
        return Err(AppError::bad("the object is not in the trash"));
    }
    let parent_gone = match &parent {
        Some(p) => in_trash(&st, &p.parse().map_err(anyhow::Error::from)?).await?,
        None => false,
    };
    sqlx::query("UPDATE objects SET trashed_at = NULL, parent_id = ?, updated_at = ? WHERE id = ?")
        .bind(if parent_gone { None } else { parent })
        .bind(now())
        .bind(id.to_string())
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Objects in the trash, most recently deleted first.
async fn list_trash(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Vec<Object>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let rows = sqlx::query_as::<_, Object>(&format!(
        "SELECT {COLUMNS} FROM objects WHERE token_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC"
    ))
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

async fn empty_trash(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<StatusCode> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM objects WHERE token_id = ? AND trashed_at IS NOT NULL")
        .bind(&token)
        .fetch_all(&st.db)
        .await?;
    purge(&st, &token, ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes subtrees; ones already gone (inside another purged folder) are skipped.
async fn purge(st: &AppState, token: &str, ids: Vec<String>) -> AppResult<()> {
    for id in ids {
        let id: Uuid = id.parse().map_err(anyhow::Error::from)?;
        match delete_subtree(st, token, &id).await {
            Ok(()) | Err(AppError::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct PendingUpload {
    #[serde(flatten)]
    object: Object,
    /// Encrypted bytes already stored: resume with `PUT content?offset=received`.
    received: u64,
}

/// Unfinished uploads, so the client can resume them after a reload.
async fn list_uploads(State(st): State<AppState>, user: AuthUser, Path(token_id): Path<String>) -> AppResult<Json<Vec<PendingUpload>>> {
    let (_, token) = owned(&st, &user, &token_id).await?;
    let rows = sqlx::query_as::<_, Object>(&format!(
        "SELECT {COLUMNS} FROM objects WHERE token_id = ? AND status = 'pending' ORDER BY created_at"
    ))
    .bind(&token)
    .fetch_all(&st.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for object in rows {
        let id: Uuid = object.id.parse().map_err(anyhow::Error::from)?;
        let received = st.store.size(&content_key(&token, &id)).await?.unwrap_or(0);
        out.push(PendingUpload { object, received });
    }
    Ok(Json(out))
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
    // The freed bytes go back to the drive's reservation.
    crate::reserve::sync_logged(st, token).await;
    Ok(())
}

/// Empties trash entries older than `TRASH_TTL_SECS`. Returns how many.
pub async fn cleanup_trash(st: &AppState) -> AppResult<usize> {
    let old: Vec<(String, String)> =
        sqlx::query_as("SELECT id, token_id FROM objects WHERE trashed_at IS NOT NULL AND trashed_at < ?")
            .bind(now() - TRASH_TTL_SECS)
            .fetch_all(&st.db)
            .await?;
    let n = old.len();
    for (id, token) in old {
        purge(st, &token, vec![id]).await?;
    }
    Ok(n)
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

