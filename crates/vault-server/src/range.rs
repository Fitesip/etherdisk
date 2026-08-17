//! Serving blobs with single-range HTTP Range support (video seeking decrypts per chunk).

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::storage::BlobStore;
use crate::{AppError, AppResult};

/// Parses a `Range` header against a blob of `len` bytes.
/// `Ok(None)`: serve the whole blob (no header, or a form we don't support, e.g. multi-range).
/// Returns an inclusive `(start, end)`; `Err` means 416.
#[allow(clippy::result_unit_err)]
pub fn parse_range(value: &str, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = value.trim().strip_prefix("bytes=") else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((a, b)) = spec.split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    let range = if a.is_empty() {
        // suffix: last N bytes
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 || len == 0 {
            return Err(());
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().map_err(|_| ())?;
        let end = if b.is_empty() { u64::MAX } else { b.parse().map_err(|_| ())? };
        if start > end || start >= len {
            return Err(());
        }
        (start, end.min(len - 1))
    };
    Ok(Some(range))
}

pub async fn serve_blob(store: &dyn BlobStore, key: &str, len: u64, headers: &HeaderMap) -> AppResult<Response> {
    let range = match headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        Some(v) => parse_range(v, len).map_err(|_| AppError::RangeNotSatisfiable { len })?,
        None => None,
    };
    let (status, start, count) = match range {
        Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e - s + 1),
        None => (StatusCode::OK, 0, len),
    };
    let stream = store.read_range(key, start, count).await?;

    let mut resp = (
        status,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, count.to_string()),
            (header::ACCEPT_RANGES, "bytes".to_owned()),
        ],
        Body::from_stream(stream),
    )
        .into_response();
    if range.is_some() {
        resp.headers_mut()
            .insert(header::CONTENT_RANGE, format!("bytes {start}-{}/{len}", start + count - 1).parse().unwrap());
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Ok(Some((0, 9))));
        assert_eq!(parse_range("bytes=90-", 100), Ok(Some((90, 99))));
        assert_eq!(parse_range("bytes=90-500", 100), Ok(Some((90, 99))));
        assert_eq!(parse_range("bytes=-10", 100), Ok(Some((90, 99))));
        assert_eq!(parse_range("bytes=-500", 100), Ok(Some((0, 99))));
        assert_eq!(parse_range("bytes=0-1,5-6", 100), Ok(None));
        assert_eq!(parse_range("items=0-1", 100), Ok(None));
        assert_eq!(parse_range("bytes=100-", 100), Err(()));
        assert_eq!(parse_range("bytes=5-1", 100), Err(()));
        assert_eq!(parse_range("bytes=-0", 100), Err(()));
        assert_eq!(parse_range("bytes=x-1", 100), Err(()));
    }
}
