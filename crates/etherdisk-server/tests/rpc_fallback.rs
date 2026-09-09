//! The server keeps reading the chain when one of its RPC endpoints is down.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use alloy::primitives::Address;
use alloy::providers::Provider;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use etherdisk_server::chain::RpcChain;
use serde_json::{json, Value};

/// A JSON-RPC endpoint on a random local port; `reply` decides each answer.
async fn endpoint(reply: impl Fn(&Value) -> Result<Value, StatusCode> + Clone + Send + Sync + 'static) -> String {
    let app = Router::new().route(
        "/",
        post(move |Json(req): Json<Value>| {
            let reply = reply.clone();
            async move {
                let result = reply(&req)?;
                Ok::<_, StatusCode>(Json(json!({ "jsonrpc": "2.0", "id": req["id"], "result": result })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/")
}

#[tokio::test]
async fn a_dead_endpoint_falls_back_to_the_next() {
    let dead_hits = Arc::new(AtomicUsize::new(0));
    let hits = dead_hits.clone();
    let dead = endpoint(move |_| {
        hits.fetch_add(1, Ordering::SeqCst);
        Err(StatusCode::BAD_GATEWAY)
    })
    .await;
    let live = endpoint(|_| Ok(json!("0x2a"))).await;

    let chain = RpcChain::new(&[dead, live], Address::ZERO).unwrap();
    for _ in 0..5 {
        assert_eq!(chain.provider.get_block_number().await.unwrap(), 42);
    }
    // Once ranked down, the dead endpoint stops being asked first.
    assert!(dead_hits.load(Ordering::SeqCst) < 5, "dead endpoint asked {} times", dead_hits.load(Ordering::SeqCst));
}

#[tokio::test]
async fn rate_limited_answers_are_retried() {
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let busy = endpoint(move |_| if n.fetch_add(1, Ordering::SeqCst) < 2 { Err(StatusCode::TOO_MANY_REQUESTS) } else { Ok(json!("0x7")) }).await;
    let chain = RpcChain::new(&[busy], Address::ZERO).unwrap();
    assert_eq!(chain.provider.get_block_number().await.unwrap(), 7);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn needs_at_least_one_endpoint() {
    assert!(RpcChain::new(&[], Address::ZERO).is_err());
}
