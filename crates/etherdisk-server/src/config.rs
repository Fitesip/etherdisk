use std::path::PathBuf;
use std::str::FromStr;

use alloy::primitives::Address;
use anyhow::Context;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    /// Storage volumes (`DATA_DIR`, comma-separated), e.g. one per RAID array.
    pub data_dirs: Vec<PathBuf>,
    /// One or more endpoints (`RPC_URL`, comma-separated): the first that works is used.
    pub rpc_urls: Vec<String>,
    pub contract_address: Address,
    pub chain_id: u64,
    /// Block the contract was deployed in; the Transfer indexer starts here.
    pub start_block: u64,
    /// Max block span per eth_getLogs call (public RPCs limit this).
    pub log_block_range: u64,
    pub confirmations: u64,
    /// Expected `domain` in Sign-In with Ethereum messages, e.g. `localhost:3000`.
    pub siwe_domain: String,
    pub cors_origins: Vec<String>,
    pub session_ttl_secs: i64,
    /// Take the client IP from `X-Forwarded-For` (only behind a trusted reverse proxy).
    pub trust_proxy: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            bind_addr: var_or("BIND_ADDR", "127.0.0.1:8787"),
            database_url: var_or("DATABASE_URL", "sqlite://data/etherdisk.db"),
            data_dirs: var_or("DATA_DIR", "data/blobs").split(',').map(str::trim).filter(|d| !d.is_empty()).map(PathBuf::from).collect(),
            rpc_urls: var("RPC_URL")?.split(',').map(|u| u.trim().to_owned()).filter(|u| !u.is_empty()).collect(),
            contract_address: parse("CONTRACT_ADDRESS", &var("CONTRACT_ADDRESS")?)?,
            chain_id: parse("CHAIN_ID", &var_or("CHAIN_ID", "11155111"))?,
            start_block: parse("START_BLOCK", &var("START_BLOCK")?)?,
            log_block_range: parse("LOG_BLOCK_RANGE", &var_or("LOG_BLOCK_RANGE", "500"))?,
            confirmations: parse("CONFIRMATIONS", &var_or("CONFIRMATIONS", "2"))?,
            siwe_domain: var_or("SIWE_DOMAIN", "localhost:3000"),
            cors_origins: var_or("CORS_ORIGINS", "http://localhost:3000")
                .split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect(),
            session_ttl_secs: parse::<i64>("SESSION_TTL_HOURS", &var_or("SESSION_TTL_HOURS", "168"))? * 3600,
            trust_proxy: var_or("TRUST_PROXY", "false") == "true",
        })
    }
}

fn var(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

fn var_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn parse<T: FromStr>(name: &str, v: &str) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    v.parse().map_err(|e| anyhow::anyhow!("{name}: {e}"))
}
