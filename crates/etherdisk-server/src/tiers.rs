//! Public numbers about the tiers: how many drives were minted in each.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::{AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/tiers/stats", get(stats))
}

#[derive(Serialize)]
struct TierStat {
    tier_id: i64,
    minted: i64,
}

/// Drives minted per tier (tiers with none are left out). Public: it is on-chain anyway.
async fn stats(State(st): State<AppState>) -> AppResult<Json<Vec<TierStat>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT tier_id, COUNT(*) FROM tier_mints GROUP BY tier_id ORDER BY tier_id")
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows.into_iter().map(|(tier_id, minted)| TierStat { tier_id, minted }).collect()))
}
