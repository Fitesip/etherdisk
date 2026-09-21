//! Alerts reach Telegram through the Bot API.

use std::sync::{Arc, Mutex};

use axum::extract::Path;
use axum::routing::post;
use axum::{Json, Router};
use etherdisk_server::monitor::Telegram;
use serde_json::{json, Value};

#[tokio::test]
async fn sends_to_the_configured_chat() {
    let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let log = seen.clone();
    let app = Router::new().route(
        "/{bot}/{method}",
        post(move |Path((bot, method)): Path<(String, String)>, Json(body): Json<Value>| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push((format!("{bot}/{method}"), body));
                Json(json!({ "ok": true, "result": {} }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let tg = Telegram::new(&format!("http://{addr}/"), "123:SECRET", "-100500");
    tg.send("🟠 Мало места").await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, "bot123:SECRET/sendMessage");
    assert_eq!(seen[0].1["chat_id"], "-100500");
    assert_eq!(seen[0].1["text"], "🟠 Мало места");
}

#[tokio::test]
async fn a_rejected_message_is_an_error() {
    let app = Router::new().route("/{bot}/{method}", post(|| async { (axum::http::StatusCode::UNAUTHORIZED, "no") }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    assert!(Telegram::new(&format!("http://{addr}"), "bad", "1").send("x").await.is_err());
}
