use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::http::{header, HeaderValue, Method};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use etherdisk_server::chain::{Ownership, RpcChain, WithLegacy};
use etherdisk_server::monitor::Monitor;
use etherdisk_server::volumes::VolumeStore;
use etherdisk_server::{connect_db, ideas, indexer, objects, AppState, Config};

const OWNER_CACHE_TTL: Duration = Duration::from_secs(10);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(3600);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "etherdisk_server=info,tower_http=info".into()))
        .init();

    let config = Config::from_env()?;
    if let Some(dir) = config.database_url.strip_prefix("sqlite://").and_then(|p| std::path::Path::new(p).parent()) {
        std::fs::create_dir_all(dir)?;
    }
    let db = connect_db(&config.database_url).await?;
    etherdisk_server::bind_deployment(&db, config.contract_address, config.chain_id, config.legacy_contract_address).await?;
    let store = Arc::new(VolumeStore::open(&config.data_dirs, db.clone()).await?);
    for v in store.info().await? {
        tracing::info!(volume = %v.id, path = %v.root.display(), free_gb = v.available_bytes >> 30, total_gb = v.total_bytes >> 30, drives = v.vaults, "storage volume");
    }
    let rpc = Arc::new(RpcChain::new(&config.rpc_urls, config.contract_address)?);
    let chain = match config.legacy_contract_address {
        Some(legacy) => {
            tracing::info!(%legacy, "drives not swapped yet are read from the legacy contract");
            let both = WithLegacy {
                current: rpc.clone(),
                current_address: config.contract_address,
                legacy: Arc::new(RpcChain::new(&config.rpc_urls, legacy)?),
            };
            Ownership::new(Arc::new(both), OWNER_CACHE_TTL)
        }
        None => Ownership::new(rpc.clone(), OWNER_CACHE_TTL),
    };
    let state = AppState::new(db, store.clone(), chain, config.clone());

    tokio::spawn(indexer::run(state.clone(), rpc.clone()));
    tokio::spawn(Arc::new(Monitor::new(state.clone(), store, rpc)).run());
    tokio::spawn({
        let st = state.clone();
        async move {
            match ideas::drop_stale_votes(&st).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(dropped = n, "ideas: dropped votes of tokens that changed hands"),
                Err(e) => tracing::warn!("ideas: checking votes: {e:#}"),
            }
        }
    });
    tokio::spawn(cleanup(state.clone()));

    let origins = config.cors_origins.iter().map(|o| o.parse()).collect::<Result<Vec<HeaderValue>, _>>()?;
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE])
        .expose_headers([header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES]);

    // The API serves JSON and ciphertext only: never let a browser render it as a page.
    let app = etherdisk_server::router(state)
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; sandbox"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(cors)
        .layer(TraceLayer::new_for_http());
    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("cannot listen on {} (port busy or reserved? change BIND_ADDR)", config.bind_addr))?;
    tracing::info!("listening on {}", config.bind_addr);
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); }).await?;
    Ok(())
}

/// Drops abandoned uploads, old trash, expired links, sessions and nonces.
async fn cleanup(st: AppState) {
    loop {
        if let Err(e) = objects::cleanup_pending(&st).await {
            tracing::warn!("cleanup: {e}");
        }
        if let Err(e) = objects::cleanup_trash(&st).await {
            tracing::warn!("cleanup: {e}");
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        for q in [
            "DELETE FROM sessions WHERE expires_at < ?",
            "DELETE FROM auth_nonces WHERE expires_at < ?",
            "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?",
        ] {
            if let Err(e) = sqlx::query(q).bind(now).execute(&st.db).await {
                tracing::warn!("cleanup: {e}");
            }
        }
        tokio::time::sleep(CLEANUP_INTERVAL).await;
    }
}
