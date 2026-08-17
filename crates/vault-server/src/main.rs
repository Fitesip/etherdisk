use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::http::{header, HeaderValue, Method};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use vault_server::chain::{Ownership, RpcChain};
use vault_server::storage::LocalStore;
use vault_server::{connect_db, indexer, objects, AppState, Config};

const OWNER_CACHE_TTL: Duration = Duration::from_secs(30);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(3600);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "vault_server=info,tower_http=info".into()))
        .init();

    let config = Config::from_env()?;
    if let Some(dir) = config.database_url.strip_prefix("sqlite://").and_then(|p| std::path::Path::new(p).parent()) {
        std::fs::create_dir_all(dir)?;
    }
    let db = connect_db(&config.database_url).await?;
    let store = Arc::new(LocalStore::new(&config.data_dir)?);
    let rpc = Arc::new(RpcChain::new(&config.rpc_url, config.contract_address)?);
    let chain = Ownership::new(rpc.clone(), OWNER_CACHE_TTL);
    let state = AppState::new(db, store, chain, config.clone());

    tokio::spawn(indexer::run(state.clone(), rpc));
    tokio::spawn(cleanup(state.clone()));

    let origins = config.cors_origins.iter().map(|o| o.parse()).collect::<Result<Vec<HeaderValue>, _>>()?;
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE])
        .expose_headers([header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES]);

    let app = vault_server::router(state).layer(cors).layer(TraceLayer::new_for_http());
    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("cannot listen on {} (port busy or reserved? change BIND_ADDR)", config.bind_addr))?;
    tracing::info!("listening on {}", config.bind_addr);
    axum::serve(listener, app).with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); }).await?;
    Ok(())
}

/// Drops abandoned uploads, expired sessions and nonces.
async fn cleanup(st: AppState) {
    loop {
        if let Err(e) = objects::cleanup_pending(&st).await {
            tracing::warn!("cleanup: {e}");
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        for q in ["DELETE FROM sessions WHERE expires_at < ?", "DELETE FROM auth_nonces WHERE expires_at < ?"] {
            if let Err(e) = sqlx::query(q).bind(now).execute(&st.db).await {
                tracing::warn!("cleanup: {e}");
            }
        }
        tokio::time::sleep(CLEANUP_INTERVAL).await;
    }
}
