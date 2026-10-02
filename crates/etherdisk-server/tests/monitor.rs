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

    let tg = Telegram::new(&format!("http://{addr}/"), "123:SECRET", "-100500", None).unwrap();
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
    assert!(Telegram::new(&format!("http://{addr}"), "bad", "1", None).unwrap().send("x").await.is_err());
}

/// With a proxy, requests go to it (absolute-form URL), not to the API host.
#[tokio::test]
async fn goes_through_the_proxy() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let proxy = Router::new().fallback(move |req: axum::extract::Request| {
        let log = log.clone();
        async move {
            log.lock().unwrap().push(req.uri().to_string());
            Json(json!({ "ok": true, "result": {} }))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, proxy).await.unwrap() });

    let tg = Telegram::new("http://telegram.invalid", "123:SECRET", "1", Some(&format!("http://{addr}"))).unwrap();
    tg.send("через прокси").await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["http://telegram.invalid/bot123:SECRET/sendMessage"]);
}

#[test]
fn a_bad_proxy_url_is_an_error() {
    assert!(Telegram::new("https://api.telegram.org", "t", "1", Some("not a url")).is_err());
}
