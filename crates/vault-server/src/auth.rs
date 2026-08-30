//! Sign-In with Ethereum (EIP-4361) and bearer-token sessions.

use alloy::primitives::Address;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{now, random_hex, AppError, AppResult, AppState};

const NONCE_TTL_SECS: i64 = 10 * 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/nonce", get(nonce))
        .route("/auth/verify", post(verify))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
}

#[derive(Serialize)]
struct NonceResponse {
    nonce: String,
}

async fn nonce(State(st): State<AppState>) -> AppResult<Json<NonceResponse>> {
    // 32 hex chars: satisfies the SIWE nonce grammar (alphanumeric, >= 8 chars).
    let nonce = random_hex(16);
    sqlx::query("INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)")
        .bind(&nonce)
        .bind(now() + NONCE_TTL_SECS)
        .execute(&st.db)
        .await?;
    Ok(Json(NonceResponse { nonce }))
}

#[derive(Deserialize)]
struct VerifyRequest {
    message: String,
    /// 0x-prefixed 65-byte signature.
    signature: String,
}

#[derive(Serialize)]
struct SessionResponse {
    token: String,
    address: Address,
    expires_at: i64,
}

async fn verify(State(st): State<AppState>, Json(req): Json<VerifyRequest>) -> AppResult<Json<SessionResponse>> {
    let unauthorized = |_| AppError::Unauthorized;
    let message: siwe::Message = req.message.parse().map_err(|_| AppError::bad("malformed SIWE message"))?;
    let signature = alloy::hex::decode(&req.signature).map_err(|_| AppError::bad("malformed signature"))?;

    if message.chain_id != st.config.chain_id {
        return Err(AppError::bad("wrong chain id"));
    }
    // Single use: consumed before the signature check, so a failed attempt burns it too.
    let consumed = sqlx::query("DELETE FROM auth_nonces WHERE nonce = ? AND expires_at > ?")
        .bind(&message.nonce)
        .bind(now())
        .execute(&st.db)
        .await?
        .rows_affected();
    if consumed == 0 {
        return Err(AppError::Unauthorized);
    }

    let opts = siwe::VerificationOpts {
        domain: Some(st.config.siwe_domain.parse().map_err(|_| anyhow::anyhow!("invalid SIWE_DOMAIN"))?),
        nonce: Some(message.nonce.clone()),
        ..Default::default()
    };
    message.verify(&signature, &opts).await.map_err(unauthorized)?;

    let address = Address::from(message.address);
    let token = random_hex(32);
    let expires_at = now() + st.config.session_ttl_secs;
    sqlx::query("INSERT INTO sessions (token_hash, address, expires_at) VALUES (?, ?, ?)")
        .bind(token_hash(&token))
        .bind(address.to_string().to_lowercase())
        .bind(expires_at)
        .execute(&st.db)
        .await?;
    Ok(Json(SessionResponse { token, address, expires_at }))
}

async fn logout(State(st): State<AppState>, headers: HeaderMap) -> AppResult<StatusCode> {
    if let Some(token) = bearer(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(token_hash(token)).execute(&st.db).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct MeResponse {
    address: Address,
}

async fn me(AuthUser(address): AuthUser) -> Json<MeResponse> {
    Json(MeResponse { address })
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

/// The signed-in wallet. Rejects with 401 without a valid session.
/// As `Option<AuthUser>` it is optional: `None` without a valid session.
pub struct AuthUser(pub Address);

impl axum::extract::OptionalFromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> AppResult<Option<Self>> {
        match <AuthUser as FromRequestParts<AppState>>::from_request_parts(parts, st).await {
            Ok(u) => Ok(Some(u)),
            Err(AppError::Unauthorized) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> AppResult<Self> {
        let token = bearer(&parts.headers).ok_or(AppError::Unauthorized)?;
        let address: Option<String> =
            sqlx::query_scalar("SELECT address FROM sessions WHERE token_hash = ? AND expires_at > ?")
                .bind(token_hash(token))
                .bind(now())
                .fetch_optional(&st.db)
                .await?;
        let address = address.ok_or(AppError::Unauthorized)?;
        Ok(AuthUser(address.parse().map_err(|e| anyhow::anyhow!("bad stored address: {e}"))?))
    }
}
