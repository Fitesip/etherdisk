//! Token-bucket rate limiting, per client IP (and per wallet for a few actions).
//!
//! In memory and per process: enough for one server; behind several instances it would
//! need a shared store. Behind a reverse proxy set `TRUST_PROXY=true` so the client IP is
//! taken from `X-Forwarded-For` instead of the proxy's address.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;

/// Sustained rate and burst size of one bucket.
#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub name: &'static str,
    pub per_minute: u32,
    pub burst: u32,
}

/// Sign-in: slows down nonce farming and signature guessing.
pub const AUTH: Rule = Rule { name: "auth", per_minute: 30, burst: 15 };
/// Public links and lookups. Generous: streaming a video is many range requests.
pub const PUBLIC: Rule = Rule { name: "public", per_minute: 1200, burst: 300 };
/// Everything else (signed in): uploads in parts, a grid of thumbnails, ...
pub const DEFAULT: Rule = Rule { name: "default", per_minute: 3000, burst: 1000 };
/// New ideas, per wallet.
pub const IDEA_CREATE: Rule = Rule { name: "idea-create", per_minute: 1, burst: 5 };
/// Votes, per wallet.
pub const VOTE: Rule = Rule { name: "vote", per_minute: 30, burst: 20 };

const MAX_BUCKETS: usize = 100_000;
const IDLE_SECS: u64 = 600;

struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Default)]
pub struct Limiter {
    buckets: Mutex<HashMap<(&'static str, String), Bucket>>,
}

impl Limiter {
    /// Takes one token for `key`; `Err(seconds)` says when to retry.
    pub fn check(&self, rule: Rule, key: &str) -> Result<(), u64> {
        let now = Instant::now();
        let rate = rule.per_minute as f64 / 60.0;
        let mut map = self.buckets.lock().unwrap();
        if map.len() > MAX_BUCKETS {
            // Every rule refills within minutes: idle buckets carry no state.
            map.retain(|_, b| now.duration_since(b.last).as_secs() < IDLE_SECS);
        }
        let b = map.entry((rule.name, key.to_owned())).or_insert(Bucket { tokens: rule.burst as f64, last: now });
        b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * rate).min(rule.burst as f64);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - b.tokens) / rate).ceil().max(1.0) as u64)
        }
    }
}

/// 429 with `Retry-After`.
pub fn too_many(retry_after: u64) -> Response {
    let mut r = (StatusCode::TOO_MANY_REQUESTS, axum::Json(serde_json::json!({ "error": "rate_limited", "message": "too many requests, slow down" })))
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&retry_after.to_string()) {
        r.headers_mut().insert(header::RETRY_AFTER, v);
    }
    r
}

fn client_ip(st: &AppState, req: &Request) -> String {
    if st.config.trust_proxy {
        if let Some(ip) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return ip.to_owned();
        }
    }
    req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string()).unwrap_or_else(|| "unknown".into())
}

async fn limit(st: AppState, rule: Rule, req: Request, next: Next) -> Response {
    let ip = client_ip(&st, &req);
    match st.limiter.check(rule, &ip) {
        Ok(()) => next.run(req).await,
        Err(retry) => too_many(retry),
    }
}

pub async fn auth(State(st): State<AppState>, req: Request, next: Next) -> Response {
    limit(st, AUTH, req, next).await
}

pub async fn public(State(st): State<AppState>, req: Request, next: Next) -> Response {
    limit(st, PUBLIC, req, next).await
}

pub async fn default(State(st): State<AppState>, req: Request, next: Next) -> Response {
    limit(st, DEFAULT, req, next).await
}
