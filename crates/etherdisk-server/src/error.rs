use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,
    #[error("authentication required")]
    Unauthorized,
    #[error("not the owner of this vault")]
    Forbidden,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("vault storage quota exceeded")]
    QuotaExceeded,
    /// The upload fits the drive's capacity, but the server has no disk space reserved for
    /// that part of it yet (storage ran out): not the user's doing.
    #[error("the server has no room for this drive's full capacity yet")]
    StorageShort,
    /// The drive still lives on an earlier contract: it opens and downloads, but changes only
    /// after it moves to the current one (docs/MIGRATION.md).
    #[error("this drive is on an old contract; move it to the new one to change it")]
    OldContract,
    #[error("too many requests")]
    RateLimited(u64),
    #[error("requested range not satisfiable")]
    RangeNotSatisfiable { len: u64 },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::Conflict(msg.into())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        Self::Internal(e.into())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::QuotaExceeded => (StatusCode::INSUFFICIENT_STORAGE, "quota_exceeded"),
            Self::StorageShort => (StatusCode::INSUFFICIENT_STORAGE, "storage_short"),
            Self::OldContract => (StatusCode::CONFLICT, "old_contract"),
            Self::RateLimited(retry) => return crate::ratelimit::too_many(*retry),
            Self::RangeNotSatisfiable { len } => {
                return (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(axum::http::header::CONTENT_RANGE, format!("bytes */{len}"))],
                )
                    .into_response()
            }
            Self::Internal(e) => {
                tracing::error!("internal error: {e:#}");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal" }))).into_response();
            }
        };
        (status, Json(json!({ "error": code, "message": self.to_string() }))).into_response()
    }
}
