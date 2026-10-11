//! Follows `Transfer` events of the Etherdisk contract. Also keeps `token_owners`, the
//! source of "this wallet's drives" lists (the contract has no per-owner enumeration), and
//! from `DriveMinted` the tier of each drive (`tier_mints`, for the "Popular" tier).
//! On a transfer the token's links are revoked and its cached owner dropped,
//! so the previous owner loses access immediately. Files and the key blob stay:
//! they belong to the token, and the new owner unlocks them with the passphrase.

use std::time::Duration;

use alloy::primitives::{Address, U256};
use alloy::providers::Provider;
use alloy::rpc::types::Filter;
use alloy::sol_types::SolEvent;

use crate::chain::{DriveMinted, RpcChain, Transfer};
use crate::{handover, ideas, vaults};
use crate::shares::revoke_all;
use crate::{AppResult, AppState};

const POLL_INTERVAL: Duration = Duration::from_secs(12);

/// Attempts at filling the tables from past events before new blocks get priority.
const BACKFILL_ATTEMPTS: u32 = 10;

pub async fn run(st: AppState, chain: std::sync::Arc<RpcChain>) {
    // New transfers must not wait forever on old ones (they revoke links and access): if the
    // RPC can't serve the old logs, carry on and try again at the next start.
    for attempt in 1..=BACKFILL_ATTEMPTS {
        match backfill(&st, &chain).await {
            Ok(()) => break,
            Err(e) if attempt == BACKFILL_ATTEMPTS => tracing::error!(
                "indexer: backfilling past events failed {BACKFILL_ATTEMPTS} times ({e:#}); following new blocks without it.                  Wallets' drive lists and tier counts may miss older drives until a restart succeeds"
            ),
            Err(e) => {
                tracing::warn!("indexer: backfilling past events: {e:#}");
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        }
    }
    loop {
        match poll(&st, &chain).await {
            Ok(true) => continue, // still catching up
            Ok(false) => {}
            Err(e) => tracing::warn!("indexer: {e:#}"),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Processes one batch of blocks. Returns true if there are more blocks to process.
async fn poll(st: &AppState, chain: &RpcChain) -> anyhow::Result<bool> {
    let cfg = &st.config;
    let next: Option<i64> = sqlx::query_scalar("SELECT next_block FROM indexer_state WHERE id = 1")
        .fetch_optional(&st.db)
        .await?;
    let from = next.map_or(cfg.start_block, |n| n as u64);
    let head = chain.provider.get_block_number().await?.saturating_sub(cfg.confirmations);
    if from > head {
        return Ok(false);
    }
    let to = head.min(from + cfg.log_block_range.max(1) - 1);

    let filter = Filter::new()
        .address(cfg.contract_address)
        .event_signature(vec![Transfer::SIGNATURE_HASH, DriveMinted::SIGNATURE_HASH])
        .from_block(from)
        .to_block(to);
    for log in chain.provider.get_logs(&filter).await? {
        if log.topic0() == Some(&DriveMinted::SIGNATURE_HASH) {
            let ev = log.log_decode::<DriveMinted>()?.inner.data;
            on_mint(st, ev.tokenId, ev.tierId).await?;
        } else {
            let ev = log.log_decode::<Transfer>()?.inner.data;
            on_transfer(st, ev.from, ev.to, ev.tokenId).await?;
        }
    }

    sqlx::query(
        "INSERT INTO indexer_state (id, next_block, owners_synced, mints_synced) VALUES (1, ?, 1, 1)
         ON CONFLICT (id) DO UPDATE SET next_block = excluded.next_block",
    )
    .bind((to + 1) as i64)
    .execute(&st.db)
    .await?;
    Ok(to < head)
}

/// A database from before `token_owners` or `tier_mints`: fill them from the blocks already
/// indexed, without the other effects of those events (links, handovers, votes were
/// handled back then). Replaying both is harmless: owners end up the same, mints are
/// recorded once per token.
async fn backfill(st: &AppState, chain: &RpcChain) -> anyhow::Result<()> {
    let row: Option<(i64, i64, i64)> = sqlx::query_as("SELECT next_block, owners_synced, mints_synced FROM indexer_state WHERE id = 1")
        .fetch_optional(&st.db)
        .await?;
    let Some((next, owners_synced, mints_synced)) = row else { return Ok(()) };
    if owners_synced == 1 && mints_synced == 1 {
        return Ok(());
    }
    let cfg = &st.config;
    let mut from = cfg.start_block;
    while from < next as u64 {
        let to = (next as u64 - 1).min(from + cfg.log_block_range.max(1) - 1);
        let filter = Filter::new()
            .address(cfg.contract_address)
            .event_signature(vec![Transfer::SIGNATURE_HASH, DriveMinted::SIGNATURE_HASH])
            .from_block(from)
            .to_block(to);
        for log in chain.provider.get_logs(&filter).await? {
            if log.topic0() == Some(&DriveMinted::SIGNATURE_HASH) {
                let ev = log.log_decode::<DriveMinted>()?.inner.data;
                on_mint(st, ev.tokenId, ev.tierId).await?;
            } else {
                let ev = log.log_decode::<Transfer>()?.inner.data;
                set_owner(st, ev.to, &ev.tokenId.to_string()).await?;
            }
        }
        from = to + 1;
    }
    sqlx::query("UPDATE indexer_state SET owners_synced = 1, mints_synced = 1 WHERE id = 1").execute(&st.db).await?;
    tracing::info!("indexer: drive owners and tiers backfilled up to block {next}");
    Ok(())
}

/// Records the tier a drive was minted in (once per token).
pub async fn on_mint(st: &AppState, token_id: U256, tier_id: U256) -> AppResult<()> {
    sqlx::query("INSERT OR IGNORE INTO tier_mints (token_id, tier_id) VALUES (?, ?)")
        .bind(token_id.to_string())
        .bind(i64::try_from(tier_id).unwrap_or(i64::MAX))
        .execute(&st.db)
        .await?;
    Ok(())
}

async fn set_owner(st: &AppState, to: Address, token: &str) -> AppResult<()> {
    if to == Address::ZERO {
        sqlx::query("DELETE FROM token_owners WHERE token_id = ?").bind(token).execute(&st.db).await?;
    } else {
        sqlx::query("INSERT INTO token_owners (token_id, owner) VALUES (?, ?) ON CONFLICT (token_id) DO UPDATE SET owner = excluded.owner")
            .bind(token)
            .bind(format!("{to:#x}"))
            .execute(&st.db)
            .await?;
    }
    Ok(())
}

pub async fn on_transfer(st: &AppState, from: Address, to: Address, token_id: U256) -> AppResult<()> {
    st.chain.invalidate(token_id);
    set_owner(st, to, &token_id.to_string()).await?;
    if from != Address::ZERO {
        let token = token_id.to_string();
        let n = revoke_all(st, &token).await?;
        handover::on_transfer(st, from, to, &token).await?;
        ideas::on_transfer(st, &token).await?;
        vaults::on_transfer(st, to, &token).await?;
        tracing::info!(%token_id, revoked_links = n, "vault transferred");
    }
    Ok(())
}
