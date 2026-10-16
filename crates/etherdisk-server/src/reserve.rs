//! Keeps each drive's unused capacity reserved on disk (see `volumes`): set when a drive is
//! minted, shrunk before uploads take quota, grown back after deletions free it.

use crate::vaults::{parse_token, used_bytes};
use crate::{AppResult, AppState};

/// Sets the drive's reservation to its capacity minus what it stores (as far as disk space
/// allows: see `usable_capacity`).
pub async fn sync(st: &AppState, token: &str) -> AppResult<()> {
    if !st.config.reserve_space {
        return Ok(());
    }
    let id = parse_token(token)?;
    let capacity = st.chain.capacity_bytes(id).await?;
    let used = used_bytes(st, token).await?;
    let missing = st.store.reserve(token, capacity, used).await?;
    if missing > 0 {
        tracing::error!(%token, missing_gb = missing >> 30, "storage: no room to reserve this drive's capacity: add storage or close sales");
    }
    Ok(())
}

/// What the drive can store: its capacity, less what found no disk space to reserve (0 when
/// its volume had no room at all). Uploads past it are refused, so a drive that doesn't fit
/// can't eat the space its volume keeps free for the system and the database.
///
/// Brings the reservation up to date first: a drive opened or written to before the indexer
/// saw its mint gets its reservation here, and a short drive picks up space freed meanwhile.
pub async fn usable_capacity(st: &AppState, id: alloy::primitives::U256, token: &str) -> AppResult<u64> {
    let capacity = st.chain.capacity_bytes(id).await?;
    if !st.config.reserve_space {
        return Ok(capacity);
    }
    sync(st, token).await?;
    Ok(capacity.saturating_sub(st.store.shortage(token)))
}

/// The error for an upload that doesn't fit `usable` bytes: the drive is full, or the server
/// hasn't got the space it sold (then it's the server's shortage, not the user's).
pub async fn too_big(st: &AppState, id: alloy::primitives::U256, usable: u64) -> crate::AppError {
    match st.chain.capacity_bytes(id).await {
        Ok(capacity) if usable < capacity => crate::AppError::StorageShort,
        _ => crate::AppError::QuotaExceeded,
    }
}

/// The same, for after a request's own work is done: a failure is logged, not returned.
pub async fn sync_logged(st: &AppState, token: &str) {
    if let Err(e) = sync(st, token).await {
        tracing::warn!(%token, "storage: reserving space: {e}");
    }
}

/// At startup: every known drive (minted, or with files), e.g. after an upgrade that added
/// reservations or a restore from backup.
pub async fn sync_all(st: &AppState) {
    if !st.config.reserve_space {
        return tracing::info!("storage: RESERVE_SPACE=false, drives' capacity is not reserved on disk");
    }
    let tokens: Vec<String> =
        match sqlx::query_scalar("SELECT token_id FROM token_owners UNION SELECT token_id FROM vault_volumes").fetch_all(&st.db).await {
            Ok(t) => t,
            Err(e) => return tracing::warn!("storage: listing drives to reserve: {e}"),
        };
    for token in &tokens {
        sync_logged(st, token).await;
    }
    tracing::info!(drives = tokens.len(), "storage: drive reservations checked");
}
