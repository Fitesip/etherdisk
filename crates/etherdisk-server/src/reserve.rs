//! Keeps each drive's unused capacity reserved on disk (see `volumes`): set when a drive is
//! minted, shrunk before uploads take quota, grown back after deletions free it.

use crate::vaults::{parse_token, used_bytes};
use crate::{AppResult, AppState};

/// Sets the drive's reservation to its capacity minus what it stores.
pub async fn sync(st: &AppState, token: &str) -> AppResult<()> {
    if !st.config.reserve_space {
        return Ok(());
    }
    let id = parse_token(token)?;
    let capacity = st.chain.capacity_bytes(id).await?;
    let used = used_bytes(st, token).await?;
    let missing = st.store.reserve(token, capacity, capacity.saturating_sub(used)).await?;
    if missing > 0 {
        tracing::error!(%token, missing_gb = missing >> 30, "storage: no room to reserve this drive's capacity: add storage or close sales");
    }
    Ok(())
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
