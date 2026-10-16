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

    let tg = Telegram::new(&format!("http://{addr}/"), "123:SECRET", "-100500", &[]).unwrap();
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
    assert!(Telegram::new(&format!("http://{addr}"), "bad", "1", &[]).unwrap().send("x").await.is_err());
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

    let tg = Telegram::new("http://telegram.invalid", "123:SECRET", "1", &[format!("http://{addr}")]).unwrap();
    tg.send("через прокси").await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["http://telegram.invalid/bot123:SECRET/sendMessage"]);
}

#[test]
fn a_bad_proxy_url_is_an_error() {
    assert!(Telegram::new("https://api.telegram.org", "t", "1", &["not a url".to_owned()]).is_err());
}

/// With several proxies, a dead one gives way to the next.
#[tokio::test]
async fn a_dead_proxy_gives_way_to_the_next() {
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
    let alive = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, proxy).await.unwrap() });
    // A port nobody listens on: connections are refused at once.
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();

    let tg = Telegram::new("http://telegram.invalid", "1:T", "1", &[format!("http://{dead}"), format!("http://{alive}")]).unwrap();
    tg.send("first").await.unwrap();
    tg.send("second").await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 2, "both went through the live proxy");
}

/// Messages that can't be sent wait, and go out in order (marked late) once Telegram answers.
#[tokio::test]
async fn undelivered_messages_wait_and_go_out_late() {
    use etherdisk_server::monitor::Outbox;
    use std::sync::atomic::{AtomicBool, Ordering};

    let up = Arc::new(AtomicBool::new(false));
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (flag, log) = (up.clone(), seen.clone());
    let app = Router::new().route(
        "/{bot}/{method}",
        post(move |Json(body): Json<Value>| {
            let (flag, log) = (flag.clone(), log.clone());
            async move {
                if !flag.load(Ordering::Relaxed) {
                    return Err(axum::http::StatusCode::BAD_GATEWAY);
                }
                log.lock().unwrap().push(body["text"].as_str().unwrap().to_owned());
                Ok(Json(json!({ "ok": true, "result": {} })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let tg = Telegram::new(&format!("http://{addr}"), "1:T", "1", &[]).unwrap();

    let mut outbox = Outbox::default();
    outbox.push(1000, "🔴 Disk is down".into());
    outbox.flush(&tg, 1000).await;
    outbox.push(1100, "✅ Fixed".into());
    outbox.flush(&tg, 1100).await;
    assert_eq!(outbox.len(), 2, "kept while Telegram is down");
    assert!(seen.lock().unwrap().is_empty());

    up.store(true, Ordering::Relaxed);
    outbox.flush(&tg, 1000 + 600).await;
    assert!(outbox.is_empty());
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert!(sent[0].starts_with("⏳ С опозданием на 10 мин") && sent[0].ends_with("🔴 Disk is down"), "{}", sent[0]);
    assert!(sent[1].ends_with("✅ Fixed"));
}
