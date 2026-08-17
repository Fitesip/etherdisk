//! Follows `Transfer` events of the VaultNFT contract.
//! On a transfer the token's links are revoked and its cached owner dropped,
//! so the previous owner loses access immediately. Files and the key blob stay:
//! they belong to the token, and the new owner unlocks them with the passphrase.

use std::time::Duration;

use alloy::primitives::{Address, U256};
use alloy::providers::Provider;
use alloy::rpc::types::Filter;
use alloy::sol_types::SolEvent;

use crate::chain::{RpcChain, Transfer};
use crate::shares::revoke_all;
use crate::{AppResult, AppState};

const POLL_INTERVAL: Duration = Duration::from_secs(12);

pub async fn run(st: AppState, chain: std::sync::Arc<RpcChain>) {
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
        .event_signature(Transfer::SIGNATURE_HASH)
        .from_block(from)
        .to_block(to);
    for log in chain.provider.get_logs(&filter).await? {
        let ev = log.log_decode::<Transfer>()?.inner.data;
        on_transfer(st, ev.from, ev.tokenId).await?;
    }

    sqlx::query(
        "INSERT INTO indexer_state (id, next_block) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET next_block = excluded.next_block",
    )
    .bind((to + 1) as i64)
    .execute(&st.db)
    .await?;
    Ok(to < head)
}

pub async fn on_transfer(st: &AppState, from: Address, token_id: U256) -> AppResult<()> {
    st.chain.invalidate(token_id);
    if from != Address::ZERO {
        let n = revoke_all(st, &token_id.to_string()).await?;
        tracing::info!(%token_id, revoked_links = n, "vault transferred");
    }
    Ok(())
}
