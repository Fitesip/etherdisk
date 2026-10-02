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
    /// Alerts go to this Telegram bot and chat; without them, only to the log.
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub telegram_api_url: String,
    /// Reach Telegram through this proxy (`TELEGRAM_PROXY`: http://, https://, socks5:// or
    /// socks5h://, optionally with user:password@). Only Telegram traffic uses it.
    pub telegram_proxy: Option<String>,
    pub alert_thresholds: crate::monitor::Thresholds,
    pub monitor_interval_secs: u64,
    /// Wallets that moderate the ideas board (`IDEAS_ADMINS`, comma-separated), besides
    /// the contract owner.
    pub ideas_admins: Vec<Address>,
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
            telegram_bot_token: std::env::var("TELEGRAM_BOT_TOKEN").ok().filter(|s| !s.is_empty()),
            telegram_chat_id: std::env::var("TELEGRAM_CHAT_ID").ok().filter(|s| !s.is_empty()),
            telegram_api_url: var_or("TELEGRAM_API_URL", "https://api.telegram.org"),
            telegram_proxy: match std::env::var("TELEGRAM_PROXY").ok().filter(|s| !s.is_empty()) {
                // Checked here so a typo stops the server instead of silencing the alerts.
                // The error leaves the value out: it may hold a password.
                Some(p) => Some(reqwest::Proxy::all(&p).map(|_| p).map_err(|_| anyhow::anyhow!("TELEGRAM_PROXY is not a valid proxy URL"))?),
                None => None,
            },
            alert_thresholds: crate::monitor::Thresholds {
                free_percent: parse("ALERT_FREE_PERCENT", &var_or("ALERT_FREE_PERCENT", "15"))?,
                critical_percent: parse("ALERT_CRITICAL_PERCENT", &var_or("ALERT_CRITICAL_PERCENT", "5"))?,
                indexer_lag_blocks: parse("ALERT_INDEXER_LAG_BLOCKS", &var_or("ALERT_INDEXER_LAG_BLOCKS", "300"))?,
                errors_per_check: parse("ALERT_ERRORS_PER_CHECK", &var_or("ALERT_ERRORS_PER_CHECK", "20"))?,
            },
            monitor_interval_secs: parse("MONITOR_INTERVAL_SECS", &var_or("MONITOR_INTERVAL_SECS", "60"))?,
            ideas_admins: var_or("IDEAS_ADMINS", "")
                .split(',')
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(|a| parse("IDEAS_ADMINS", a))
                .collect::<anyhow::Result<_>>()?,
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
