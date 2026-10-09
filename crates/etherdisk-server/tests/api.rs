//! End-to-end API tests against an in-memory chain, real SIWE signatures and real
//! etherdisk-crypto ciphertext.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy::primitives::{Address, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use etherdisk_crypto::{encrypt_file, FileHeader, KdfParams, Vault};
use etherdisk_server::chain::{Chain, Ownership};
use etherdisk_server::volumes::VolumeStore;
use etherdisk_server::{bind_deployment, connect_db, indexer, AppState, Config};

// ------------------------------------------------------------ fixtures

#[derive(Default)]
struct FakeChain {
    tokens: Mutex<HashMap<U256, (Address, u32)>>,
    admin: Mutex<Address>,
}

impl FakeChain {
    fn mint(&self, id: u64, owner: Address, gb: u32) {
        self.tokens.lock().unwrap().insert(U256::from(id), (owner, gb));
    }
    fn transfer(&self, id: u64, to: Address) {
        self.tokens.lock().unwrap().get_mut(&U256::from(id)).unwrap().0 = to;
    }
}

#[async_trait]
impl Chain for FakeChain {
    async fn owner_of(&self, id: U256) -> anyhow::Result<Option<Address>> {
        Ok(self.tokens.lock().unwrap().get(&id).map(|t| t.0))
    }
    async fn capacity_gb(&self, id: U256) -> anyhow::Result<Option<u32>> {
        Ok(self.tokens.lock().unwrap().get(&id).map(|t| t.1))
    }
    async fn contract_owner(&self) -> anyhow::Result<Address> {
        Ok(*self.admin.lock().unwrap())
    }
}

const DOMAIN: &str = "localhost:3000";
const CHAIN_ID: u64 = 11155111;

struct App {
    router: Router,
    state: AppState,
    chain: Arc<FakeChain>,
    data_dir: tempfile::TempDir,
}

async fn app() -> App {
    app_with(|_| {}).await
}

async fn app_with(tweak: impl FnOnce(&mut Config)) -> App {
    let data_dir = tempfile::tempdir().unwrap();
    let mut config = Config {
        bind_addr: String::new(),
        database_url: format!("sqlite://{}", data_dir.path().join("test.db").display()),
        data_dirs: vec![data_dir.path().join("blobs")],
        rpc_urls: Vec::new(),
        contract_address: Address::ZERO,
        chain_id: CHAIN_ID,
        start_block: 0,
        log_block_range: 500,
        confirmations: 0,
        siwe_domain: DOMAIN.into(),
        cors_origins: vec![],
        session_ttl_secs: 3600,
        trust_proxy: false,
        telegram_bot_token: None,
        telegram_chat_id: None,
        telegram_api_url: String::new(),
        telegram_proxy: None,
        alert_thresholds: etherdisk_server::monitor::Thresholds {
            free_percent: 15,
            critical_percent: 5,
            indexer_lag_blocks: 300,
            errors_per_check: 20,
        },
        monitor_interval_secs: 60,
        ideas_admins: Vec::new(),
    };
    tweak(&mut config);
    let db = connect_db(&config.database_url).await.unwrap();
    let store = Arc::new(VolumeStore::open(&config.data_dirs, db.clone()).await.unwrap());
    let chain = Arc::new(FakeChain::default());
    // TTL 0: every request sees the fake chain's current state.
    let state = AppState::new(db, store, Ownership::new(chain.clone(), Duration::ZERO), config);
    App { router: etherdisk_server::router(state.clone()), state, chain, data_dir }
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not json: {:?}", String::from_utf8_lossy(&self.body)))
    }
}

impl App {
    /// Mints on the fake chain and records the owner as the indexer would.
    async fn mint(&self, id: u64, owner: Address, gb: u32) {
        self.chain.mint(id, owner, gb);
        indexer::on_transfer(&self.state, Address::ZERO, owner, U256::from(id)).await.unwrap();
    }

    async fn req(&self, method: Method, uri: &str, token: Option<&str>, body: Body, ctype: &str, extra: &[(&str, &str)]) -> Resp {
        let mut b = Request::builder().method(method).uri(uri).header(header::CONTENT_TYPE, ctype);
        if let Some(t) = token {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        let resp = self.router.clone().oneshot(b.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp.into_body().collect().await.unwrap().to_bytes().to_vec();
        Resp { status, headers, body }
    }

    async fn json(&self, method: Method, uri: &str, token: Option<&str>, body: Value) -> Resp {
        self.req(method, uri, token, Body::from(body.to_string()), "application/json", &[]).await
    }

    async fn get(&self, uri: &str, token: Option<&str>) -> Resp {
        self.req(Method::GET, uri, token, Body::empty(), "application/json", &[]).await
    }

    async fn bytes(&self, method: Method, uri: &str, token: &str, data: Vec<u8>) -> Resp {
        self.req(method, uri, Some(token), Body::from(data), "application/octet-stream", &[]).await
    }

    async fn login(&self, signer: &PrivateKeySigner) -> String {
        let nonce = self.get("/api/auth/nonce", None).await.json()["nonce"].as_str().unwrap().to_owned();
        let message = siwe_message(DOMAIN, signer.address(), CHAIN_ID, &nonce);
        let r = self.sign_in(signer, &message).await;
        assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
        r.json()["token"].as_str().unwrap().to_owned()
    }

    async fn sign_in(&self, signer: &PrivateKeySigner, message: &str) -> Resp {
        let sig = signer.sign_message(message.as_bytes()).await.unwrap();
        let signature = format!("0x{}", alloy::hex::encode(sig.as_bytes()));
        self.json(Method::POST, "/api/auth/verify", None, json!({ "message": message, "signature": signature })).await
    }
}

fn siwe_message(domain: &str, address: Address, chain_id: u64, nonce: &str) -> String {
    format!(
        "{domain} wants you to sign in with your Ethereum account:\n{}\n\nSign in to Etherdisk\n\n\
         URI: http://{domain}\nVersion: 1\nChain ID: {chain_id}\nNonce: {nonce}\nIssued At: 2025-01-01T00:00:00Z",
        address.to_checksum(None)
    )
}

fn b64(data: &[u8]) -> String {
    STANDARD.encode(data)
}

const FAST: KdfParams = KdfParams { m_cost_kib: 8, t_cost: 1, parallelism: 1 };

fn encrypt(vault: &Vault, plain: &[u8], chunk: u32) -> Vec<u8> {
    let h = FileHeader::generate(chunk).unwrap();
    encrypt_file(&vault.file_key(&h.file_salt), h, plain).unwrap()
}

/// Initializes the vault and uploads one file. Returns (vault, file id, ciphertext).
async fn setup_vault_with_file(app: &App, token: &str, plain: &[u8]) -> (Vault, Uuid, Vec<u8>) {
    let (vault, blob) = Vault::create_with_params("pass", FAST).unwrap();
    let r = app.json(Method::PUT, "/api/vaults/1/key", Some(token), json!({ "key_blob": b64(&blob), "previous_etag": null })).await;
    assert_eq!(r.status, StatusCode::OK);
    let (id, ct) = upload(app, token, &vault, None, plain).await;
    (vault, id, ct)
}

async fn upload(app: &App, token: &str, vault: &Vault, parent: Option<Uuid>, plain: &[u8]) -> (Uuid, Vec<u8>) {
    let id = Uuid::new_v4();
    let ct = encrypt(vault, plain, 64);
    let meta = vault.seal_metadata(b"{\"name\":\"a.txt\"}", id.as_bytes()).unwrap();
    let r = app
        .json(Method::POST, "/api/vaults/1/files", Some(token), json!({
            "id": id, "parent_id": parent, "metadata": b64(&meta), "size": ct.len(), "thumb_size": null
        }))
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&r.body));
    let half = ct.len() / 2;
    let base = format!("/api/vaults/1/files/{id}");
    assert_eq!(app.bytes(Method::PUT, &format!("{base}/content?offset=0"), token, ct[..half].to_vec()).await.status, StatusCode::OK);
    let r = app.bytes(Method::PUT, &format!("{base}/content?offset={half}"), token, ct[half..].to_vec()).await;
    assert_eq!(r.json()["received"], ct.len());
    assert_eq!(app.json(Method::POST, &format!("{base}/complete"), Some(token), json!({})).await.status, StatusCode::NO_CONTENT);
    (id, ct)
}

// ------------------------------------------------------------ auth

#[tokio::test]
async fn siwe_login_and_session() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    let token = app.login(&alice).await;

    let me = app.get("/api/auth/me", Some(&token)).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.json()["address"].as_str().unwrap().parse::<Address>().unwrap(), alice.address());

    assert_eq!(app.get("/api/auth/me", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/auth/me", Some("bogus")).await.status, StatusCode::UNAUTHORIZED);

    app.json(Method::POST, "/api/auth/logout", Some(&token), json!({})).await;
    assert_eq!(app.get("/api/auth/me", Some(&token)).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn siwe_rejects_replay_wrong_domain_and_unknown_nonce() {
    let app = app().await;
    let alice = PrivateKeySigner::random();

    let nonce = app.get("/api/auth/nonce", None).await.json()["nonce"].as_str().unwrap().to_owned();
    let msg = siwe_message(DOMAIN, alice.address(), CHAIN_ID, &nonce);
    assert_eq!(app.sign_in(&alice, &msg).await.status, StatusCode::OK);
    assert_eq!(app.sign_in(&alice, &msg).await.status, StatusCode::UNAUTHORIZED, "nonce must be single use");

    let nonce = app.get("/api/auth/nonce", None).await.json()["nonce"].as_str().unwrap().to_owned();
    let phishing = siwe_message("evil.example", alice.address(), CHAIN_ID, &nonce);
    assert_eq!(app.sign_in(&alice, &phishing).await.status, StatusCode::UNAUTHORIZED);

    let msg = siwe_message(DOMAIN, alice.address(), CHAIN_ID, "neverissued123");
    assert_eq!(app.sign_in(&alice, &msg).await.status, StatusCode::UNAUTHORIZED);

    // Signed by someone else than the address in the message.
    let nonce = app.get("/api/auth/nonce", None).await.json()["nonce"].as_str().unwrap().to_owned();
    let msg = siwe_message(DOMAIN, alice.address(), CHAIN_ID, &nonce);
    assert_eq!(app.sign_in(&PrivateKeySigner::random(), &msg).await.status, StatusCode::UNAUTHORIZED);
}

// ------------------------------------------------------------ vaults & keys

#[tokio::test]
async fn key_blob_lifecycle_and_ownership() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    app.mint(2, alice.address(), 4).await;
    let (ta, tb) = (app.login(&alice).await, app.login(&bob).await);

    let list = app.get("/api/vaults", Some(&ta)).await.json();
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["token_id"], "1");
    assert_eq!(list[0]["capacity_bytes"], 1u64 << 30);
    assert_eq!(list[1]["capacity_bytes"], 4u64 << 30);
    assert_eq!(list[0]["initialized"], false);

    assert_eq!(app.get("/api/vaults/1/key", Some(&ta)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/vaults/1", Some(&tb)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/vaults/99", Some(&ta)).await.status, StatusCode::NOT_FOUND);

    let (vault, blob) = Vault::create_with_params("first", FAST).unwrap();
    let put = |blob: &[u8], prev: Value| json!({ "key_blob": b64(blob), "previous_etag": prev });
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/key", Some(&tb), put(&blob, Value::Null)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/key", Some(&ta), put(b"junk", Value::Null)).await.status, StatusCode::BAD_REQUEST);
    let r = app.json(Method::PUT, "/api/vaults/1/key", Some(&ta), put(&blob, Value::Null)).await;
    assert_eq!(r.status, StatusCode::OK);
    let etag = r.json()["etag"].clone();

    // A second "initialize" must not silently replace the DEK.
    let (_, other) = Vault::create_with_params("x", FAST).unwrap();
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/key", Some(&ta), put(&other, Value::Null)).await.status, StatusCode::CONFLICT);

    // Passphrase change: same DEK, new blob, guarded by etag.
    let rewrapped = vault.rewrap("second").unwrap();
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/key", Some(&ta), put(&rewrapped, json!("stale"))).await.status, StatusCode::CONFLICT);
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/key", Some(&ta), put(&rewrapped, etag)).await.status, StatusCode::OK);

    let got = app.get("/api/vaults/1/key", Some(&ta)).await.json();
    let got = STANDARD.decode(got["key_blob"].as_str().unwrap()).unwrap();
    assert!(Vault::unlock(&got, "second").is_ok());
}

// ------------------------------------------------------------ files

#[tokio::test]
async fn upload_download_and_range() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;

    let plain: Vec<u8> = (0..1000u32).map(|i| (i * 31) as u8).collect();
    let (vault, id, ct) = setup_vault_with_file(&app, &t, &plain).await;

    let list = app.get("/api/vaults/1/objects", Some(&t)).await.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["size"], ct.len());
    let meta = STANDARD.decode(list[0]["metadata"].as_str().unwrap()).unwrap();
    assert_eq!(vault.open_metadata(&meta, id.as_bytes()).unwrap(), b"{\"name\":\"a.txt\"}");

    let full = app.get(&format!("/api/vaults/1/files/{id}/content"), Some(&t)).await;
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(etherdisk_crypto::decrypt_file(&vault.file_key(&FileHeader::parse(&full.body).unwrap().file_salt), &full.body).unwrap(), plain);

    // One encrypted chunk via Range, decrypted on its own (what video seeking does).
    let loc = etherdisk_crypto::chunk_location(3, 64, ct.len() as u64).unwrap();
    let range = format!("bytes={}-{}", loc.offset, loc.offset + loc.len - 1);
    let part = app
        .req(Method::GET, &format!("/api/vaults/1/files/{id}/content"), Some(&t), Body::empty(), "", &[("range", &range)])
        .await;
    assert_eq!(part.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.headers[header::CONTENT_RANGE], format!("bytes {}-{}/{}", loc.offset, loc.offset + loc.len - 1, ct.len()));
    let dec = etherdisk_crypto::FileDecryptor::new(&vault.file_key(&FileHeader::parse(&ct).unwrap().file_salt), &ct).unwrap();
    assert_eq!(dec.decrypt_chunk(3, &part.body, loc.is_last).unwrap(), plain[3 * 64..4 * 64]);

    let bad = app
        .req(Method::GET, &format!("/api/vaults/1/files/{id}/content"), Some(&t), Body::empty(), "", &[("range", "bytes=99999-")])
        .await;
    assert_eq!(bad.status, StatusCode::RANGE_NOT_SATISFIABLE);
}

#[tokio::test]
async fn upload_validation_and_rollback() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (vault, _blob) = Vault::create_with_params("p", FAST).unwrap();

    let id = Uuid::new_v4();
    let ct = encrypt(&vault, &[7u8; 300], 64);
    let thumb = encrypt(&vault, b"tiny jpeg", 64);
    let r = app
        .json(Method::POST, "/api/vaults/1/files", Some(&t), json!({
            "id": id, "parent_id": null, "metadata": "AA==", "size": ct.len(), "thumb_size": thumb.len()
        }))
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let base = format!("/api/vaults/1/files/{id}");

    // Pending files are invisible, and have nothing to download before data arrives.
    assert_eq!(app.get("/api/vaults/1/objects", Some(&t)).await.json().as_array().unwrap().len(), 0);
    assert_eq!(app.get(&format!("{base}/content"), Some(&t)).await.status, StatusCode::NOT_FOUND);

    assert_eq!(app.bytes(Method::PUT, &format!("{base}/content?offset=5"), &t, ct.clone()).await.status, StatusCode::CONFLICT);
    // Too much data: rejected and rolled back, so the same part can be retried.
    let mut too_big = ct.clone();
    too_big.push(0);
    assert_eq!(app.bytes(Method::PUT, &format!("{base}/content?offset=0"), &t, too_big).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.json(Method::POST, &format!("{base}/complete"), Some(&t), json!({})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.bytes(Method::PUT, &format!("{base}/content?offset=0"), &t, ct.clone()).await.status, StatusCode::OK);

    // Thumbnail declared but missing.
    assert_eq!(app.json(Method::POST, &format!("{base}/complete"), Some(&t), json!({})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.bytes(Method::PUT, &format!("{base}/thumbnail"), &t, b"wrong size".to_vec()).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.bytes(Method::PUT, &format!("{base}/thumbnail"), &t, thumb.clone()).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.json(Method::POST, &format!("{base}/complete"), Some(&t), json!({})).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&format!("{base}/thumbnail"), Some(&t)).await.body, thumb);

    // Not ciphertext: well-sized garbage fails the header check.
    let id2 = Uuid::new_v4();
    app.json(Method::POST, "/api/vaults/1/files", Some(&t), json!({ "id": id2, "metadata": "AA==", "size": 100 })).await;
    app.bytes(Method::PUT, &format!("/api/vaults/1/files/{id2}/content?offset=0"), &t, vec![0u8; 100]).await;
    let r = app.json(Method::POST, &format!("/api/vaults/1/files/{id2}/complete"), Some(&t), json!({})).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Duplicate id.
    let r = app.json(Method::POST, "/api/vaults/1/files", Some(&t), json!({ "id": id, "metadata": "AA==", "size": 100 })).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn quota_counts_reservations() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let gb = 1u64 << 30;
    let create = |size: u64| json!({ "id": Uuid::new_v4(), "metadata": "AA==", "size": size });

    assert_eq!(app.json(Method::POST, "/api/vaults/1/files", Some(&t), create(gb + 1)).await.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/files", Some(&t), create(gb - 1000)).await.status, StatusCode::CREATED);
    // The pending upload already holds its space.
    assert_eq!(app.json(Method::POST, "/api/vaults/1/files", Some(&t), create(1001)).await.status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/files", Some(&t), create(1000)).await.status, StatusCode::CREATED);
    assert_eq!(app.get("/api/vaults/1", Some(&t)).await.json()["used_bytes"], gb);
}

#[tokio::test]
async fn folders_move_and_recursive_delete() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (vault, _) = Vault::create_with_params("p", FAST).unwrap();

    let folder = |id: Uuid, parent: Option<Uuid>| json!({ "id": id, "parent_id": parent, "metadata": "AA==" });
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(app.json(Method::POST, "/api/vaults/1/folders", Some(&t), folder(a, None)).await.status, StatusCode::CREATED);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/folders", Some(&t), folder(b, Some(a))).await.status, StatusCode::CREATED);
    let (f, _) = upload(&app, &t, &vault, Some(b), b"deep file").await;

    let root = app.get("/api/vaults/1/objects", Some(&t)).await.json();
    assert_eq!(root.as_array().unwrap().len(), 1);
    assert_eq!(app.get(&format!("/api/vaults/1/objects?parent={b}"), Some(&t)).await.json()[0]["id"], f.to_string());

    let (app, t) = (&app, &t);
    let mv = |id: Uuid, to: Option<Uuid>| async move {
        app.json(Method::POST, &format!("/api/vaults/1/objects/{id}/move"), Some(t), json!({ "parent_id": to })).await.status
    };
    assert_eq!(mv(a, Some(b)).await, StatusCode::BAD_REQUEST, "cycle");
    assert_eq!(mv(a, Some(a)).await, StatusCode::BAD_REQUEST, "into itself");
    assert_eq!(mv(a, Some(f)).await, StatusCode::BAD_REQUEST, "into a file");
    assert_eq!(mv(f, None).await, StatusCode::NO_CONTENT);
    assert_eq!(mv(f, Some(b)).await, StatusCode::NO_CONTENT);

    let r = app.json(Method::PUT, &format!("/api/vaults/1/objects/{a}/metadata"), Some(t), json!({ "metadata": "AQI=" })).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    let blob_path = app.data_dir.path().join("blobs").join("1").join(f.to_string());
    assert!(blob_path.exists());
    assert_eq!(app.req(Method::DELETE, &format!("/api/vaults/1/objects/{a}"), Some(t), Body::empty(), "", &[]).await.status, StatusCode::NO_CONTENT);
    assert!(blob_path.exists(), "trashed, not deleted");
    let del = |uri: String| async move { app.req(Method::DELETE, &uri, Some(t), Body::empty(), "", &[]).await.status };
    assert_eq!(del(format!("/api/vaults/1/objects/{a}/permanent")).await, StatusCode::NO_CONTENT);
    assert!(!blob_path.exists());
    assert_eq!(app.get("/api/vaults/1/objects", Some(t)).await.json().as_array().unwrap().len(), 0);
    assert_eq!(app.get("/api/vaults/1", Some(t)).await.json()["used_bytes"], 0);
}

#[tokio::test]
async fn folder_path_for_breadcrumbs() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    app.mint(2, alice.address(), 1).await;
    let t = app.login(&alice).await;

    let folder = |id: Uuid, parent: Option<Uuid>| json!({ "id": id, "parent_id": parent, "metadata": "AA==" });
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    for (id, parent) in [(a, None), (b, Some(a)), (c, Some(b))] {
        assert_eq!(app.json(Method::POST, "/api/vaults/1/folders", Some(&t), folder(id, parent)).await.status, StatusCode::CREATED);
    }
    let ids = |v: Value| v.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let r = app.get(&format!("/api/vaults/1/objects/{c}/path"), Some(&t)).await;
    assert_eq!(ids(r.json()), [a, b, c].map(|u| u.to_string()));
    assert_eq!(ids(app.get(&format!("/api/vaults/1/objects/{a}/path"), Some(&t)).await.json()), [a.to_string()]);
    // Another vault of the same owner does not see it.
    assert_eq!(app.get(&format!("/api/vaults/2/objects/{c}/path"), Some(&t)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(&format!("/api/vaults/1/objects/{}/path", Uuid::new_v4()), Some(&t)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn vault_profile() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;

    let v = app.get("/api/vaults/1", Some(&t)).await.json();
    assert!(v["name"].is_null() && v["stroke"].is_null() && v["fill"].is_null());

    let put = |body: Value| app.json(Method::PUT, "/api/vaults/1/profile", Some(&t), body);
    let r = put(json!({ "name": "  Photos  ", "stroke": "#AABBCC", "fill": "#112233" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!((r.json()["name"].clone(), r.json()["stroke"].clone()), (json!("Photos"), json!("#aabbcc")));
    assert_eq!(app.get("/api/vaults", Some(&t)).await.json()[0]["fill"], "#112233");

    assert_eq!(put(json!({ "name": "x".repeat(65) })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "name": "a
b" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "fill": "red" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "fill": "#12345g" })).await.status, StatusCode::BAD_REQUEST);
    // Null/blank resets to defaults.
    let r = put(json!({ "name": " ", "stroke": null })).await.json();
    assert!(r["name"].is_null() && r["stroke"].is_null() && r["fill"].is_null());

    // Icon and cover: ids from the app's sets.
    let r = put(json!({ "icon": "camera", "cover": "waves-2", "cover_color": "#F97316" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["cover_color"], "#f97316");
    assert_eq!(put(json!({ "cover_color": "orange" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!((r.json()["icon"].clone(), r.json()["cover"].clone()), (json!("camera"), json!("waves-2")));
    assert_eq!(put(json!({ "icon": "Camera" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "cover": "<svg>" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "icon": "a".repeat(33) })).await.status, StatusCode::BAD_REQUEST);

    let tb = app.login(&bob).await;
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/profile", Some(&tb), json!({ "name": "mine" })).await.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn vault_prefs_are_the_holders_and_go_with_a_format() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let get = || app.get("/api/vaults/1/prefs", Some(&t));
    assert_eq!(get().await.json(), json!({ "blob": null }));

    let put = |blob: Value| app.json(Method::PUT, "/api/vaults/1/prefs", Some(&t), json!({ "blob": blob }));
    assert_eq!(put(json!(b64(b"sealed labels"))).await.status, StatusCode::NO_CONTENT);
    assert_eq!(get().await.json()["blob"], b64(b"sealed labels"));
    assert_eq!(put(json!(b64(&vec![0; 64 * 1024 + 1]))).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(get().await.json()["blob"], b64(b"sealed labels"), "a rejected write keeps the old prefs");

    let tb = app.login(&bob).await;
    assert_eq!(app.get("/api/vaults/1/prefs", Some(&tb)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/prefs", Some(&tb), json!({ "blob": b64(b"x") })).await.status, StatusCode::FORBIDDEN);

    app.json(Method::POST, "/api/vaults/1/reset", Some(&t), json!({ "confirm": "DELETE" })).await;
    assert_eq!(get().await.json(), json!({ "blob": null }), "a format drops them with the key");
    assert_eq!(put(json!(b64(b"new"))).await.status, StatusCode::NO_CONTENT);
    assert_eq!(put(json!(null)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(get().await.json(), json!({ "blob": null }));
}

#[tokio::test]
async fn database_is_bound_to_one_contract() {
    let dir = tempfile::tempdir().unwrap();
    let db = connect_db(&format!("sqlite://{}", dir.path().join("d.db").display())).await.unwrap();
    let (a, b) = (Address::repeat_byte(0xaa), Address::repeat_byte(0xbb));
    bind_deployment(&db, a, 1).await.unwrap();
    bind_deployment(&db, a, 1).await.unwrap(); // restart: fine
    let err = bind_deployment(&db, b, 1).await.unwrap_err().to_string();
    assert!(err.contains("DATABASE_URL"), "{err}");
    assert!(bind_deployment(&db, a, 2).await.is_err(), "other chain");
}

#[tokio::test]
async fn trash_restore_and_purge() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (vault, _) = Vault::create_with_params("p", FAST).unwrap();

    let folder = |id: Uuid, parent: Option<Uuid>| json!({ "id": id, "parent_id": parent, "metadata": "AA==" });
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    app.json(Method::POST, "/api/vaults/1/folders", Some(&t), folder(a, None)).await;
    app.json(Method::POST, "/api/vaults/1/folders", Some(&t), folder(b, None)).await;
    let (inner, _) = upload(&app, &t, &vault, Some(a), b"inside a").await;
    let (loose, _) = upload(&app, &t, &vault, None, b"loose").await;

    let (app, t) = (&app, &t);
    let call = |m: Method, uri: String| async move { app.req(m, &uri, Some(t), Body::empty(), "application/json", &[]).await };
    let ids = |v: Value| {
        let mut ids = v.as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        ids.sort();
        ids
    };
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };

    // Trash folder `a` (with its file) and the loose file.
    assert_eq!(call(Method::DELETE, format!("/api/vaults/1/objects/{a}")).await.status, StatusCode::NO_CONTENT);
    assert_eq!(call(Method::DELETE, format!("/api/vaults/1/objects/{loose}")).await.status, StatusCode::NO_CONTENT);
    assert_eq!(ids(app.get("/api/vaults/1/objects", Some(t)).await.json()), [b.to_string()]);
    assert_eq!(ids(app.get("/api/vaults/1/trash", Some(t)).await.json()), sorted(vec![a.to_string(), loose.to_string()]));
    // Search index and paths skip trashed subtrees; nothing can be created inside them.
    assert_eq!(ids(app.get("/api/vaults/1/objects/all", Some(t)).await.json()), [b.to_string()]);
    assert_eq!(app.get(&format!("/api/vaults/1/objects/{a}/path"), Some(t)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/folders", Some(t), folder(Uuid::new_v4(), Some(a))).await.status, StatusCode::BAD_REQUEST);
    let r = app.json(Method::POST, &format!("/api/vaults/1/objects/{inner}/move"), Some(t), json!({ "parent_id": b })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "objects in the trash are restored, not moved");
    // Quota still counts the trash.
    assert!(app.get("/api/vaults/1", Some(t)).await.json()["used_bytes"].as_u64().unwrap() > 0);

    // Restore the folder: its file comes back with it.
    assert_eq!(call(Method::POST, format!("/api/vaults/1/objects/{a}/restore")).await.status, StatusCode::NO_CONTENT);
    assert_eq!(ids(app.get(&format!("/api/vaults/1/objects?parent={a}"), Some(t)).await.json()), [inner.to_string()]);
    assert_eq!(call(Method::POST, format!("/api/vaults/1/objects/{a}/restore")).await.status, StatusCode::BAD_REQUEST);

    // A file restored while its folder is trashed lands in the root.
    call(Method::DELETE, format!("/api/vaults/1/objects/{inner}")).await;
    call(Method::DELETE, format!("/api/vaults/1/objects/{a}")).await;
    call(Method::POST, format!("/api/vaults/1/objects/{inner}/restore")).await;
    let root = app.get("/api/vaults/1/objects", Some(t)).await.json();
    assert!(root.as_array().unwrap().iter().any(|o| o["id"] == inner.to_string() && o["parent_id"].is_null()));

    // Empty the trash: gone for good, blobs deleted, quota freed.
    let loose_blob = app.data_dir.path().join("blobs").join("1").join(loose.to_string());
    assert!(loose_blob.exists());
    assert_eq!(call(Method::POST, "/api/vaults/1/trash/empty".into()).await.status, StatusCode::NO_CONTENT);
    assert!(!loose_blob.exists());
    assert_eq!(app.get("/api/vaults/1/trash", Some(t)).await.json().as_array().unwrap().len(), 0);
    assert_eq!(ids(app.get("/api/vaults/1/objects/all", Some(t)).await.json()), sorted(vec![b.to_string(), inner.to_string()]));
}

#[tokio::test]
async fn unfinished_uploads_can_be_listed_and_resumed() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (vault, _) = Vault::create_with_params("p", FAST).unwrap();
    let ct = encrypt(&vault, &[7u8; 5000], 1024);

    let id = Uuid::new_v4();
    let r = app
        .json(Method::POST, "/api/vaults/1/files", Some(&t), json!({ "id": id, "parent_id": null, "metadata": "AA==", "size": ct.len(), "thumb_size": null }))
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let half = ct.len() / 2;
    app.bytes(Method::PUT, &format!("/api/vaults/1/files/{id}/content?offset=0"), &t, ct[..half].to_vec()).await;

    let pending = app.get("/api/vaults/1/uploads", Some(&t)).await.json();
    assert_eq!(pending[0]["id"], id.to_string());
    assert_eq!(pending[0]["received"], half as u64);
    assert_eq!(pending[0]["size"], ct.len() as u64);

    // The owner can read back what was stored, to verify before resuming.
    let r = app.req(Method::GET, &format!("/api/vaults/1/files/{id}/content"), Some(&t), Body::empty(), "", &[("range", "bytes=0-9")]).await;
    assert_eq!(r.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.body, ct[..10]);

    // A fresh thumbnail of another size is accepted (quota re-reserved), or dropped.
    let thumb = encrypt(&vault, b"thumbnail bytes", 64);
    let r = app.bytes(Method::PUT, &format!("/api/vaults/1/files/{id}/thumbnail"), &t, thumb.clone()).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/vaults/1/uploads", Some(&t)).await.json()[0]["thumb_size"], thumb.len() as u64);
    let r = app.req(Method::DELETE, &format!("/api/vaults/1/files/{id}/thumbnail"), Some(&t), Body::empty(), "", &[]).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(app.get("/api/vaults/1/uploads", Some(&t)).await.json()[0]["thumb_size"].is_null());

    // Resume from `received`.
    let r = app.bytes(Method::PUT, &format!("/api/vaults/1/files/{id}/content?offset={half}"), &t, ct[half..].to_vec()).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(app.json(Method::POST, &format!("/api/vaults/1/files/{id}/complete"), Some(&t), json!({})).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/vaults/1/uploads", Some(&t)).await.json().as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn share_expiry_and_trashed_files() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (_vault, file, _) = setup_vault_with_file(&app, &t, b"shared").await;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;

    let share = |expires: Option<i64>| {
        app.json(Method::POST, "/api/vaults/1/shares", Some(&t), json!({
            "object_ids": [file], "manifest": "AA==", "owner_metadata": "AA==", "expires_at": expires
        }))
    };
    assert_eq!(share(Some(now - 10)).await.status, StatusCode::BAD_REQUEST, "past");
    assert_eq!(share(Some(now + 400 * 86400)).await.status, StatusCode::BAD_REQUEST, "over a year");
    let r = share(Some(now + 3600)).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let id = r.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(app.get("/api/vaults/1/shares", Some(&t)).await.json()[0]["expires_at"], now + 3600);
    assert_eq!(app.get(&format!("/api/shares/{id}"), None).await.status, StatusCode::OK);

    // Trashed files are not served; restored ones are again.
    let content = format!("/api/shares/{id}/files/{file}/content");
    assert_eq!(app.get(&content, None).await.status, StatusCode::OK);
    app.req(Method::DELETE, &format!("/api/vaults/1/objects/{file}"), Some(&t), Body::empty(), "", &[]).await;
    assert_eq!(app.get(&content, None).await.status, StatusCode::NOT_FOUND);
    app.req(Method::POST, &format!("/api/vaults/1/objects/{file}/restore"), Some(&t), Body::empty(), "", &[]).await;
    assert_eq!(app.get(&content, None).await.status, StatusCode::OK);

    // Expired links behave as revoked.
    sqlx::query("UPDATE shares SET expires_at = ? WHERE id = ?").bind(now - 1).bind(&id).execute(&app.state.db).await.unwrap();
    assert_eq!(app.get(&format!("/api/shares/{id}"), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(&content, None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn new_owner_is_not_turned_away_by_a_stale_cache() {
    let chain = Arc::new(FakeChain::default());
    let (alice, bob) = (Address::repeat_byte(0xaa), Address::repeat_byte(0xbb));
    chain.mint(1, alice, 1);
    let owners = Ownership::new(chain.clone(), Duration::from_secs(3600));
    owners.require_owner(U256::from(1), alice).await.unwrap(); // cached: alice
    chain.transfer(1, bob);
    owners.require_owner(U256::from(1), bob).await.expect("rechecked on mismatch");
    assert!(owners.require_owner(U256::from(1), alice).await.is_err(), "and the cache now knows");
}

// ------------------------------------------------------------ tier stats

#[tokio::test]
async fn tier_stats_count_mints_per_tier() {
    let app = app().await;
    assert_eq!(app.get("/api/tiers/stats", None).await.json(), json!([]));
    for (token, tier) in [(1, 1), (2, 1), (3, 0), (4, 1)] {
        indexer::on_mint(&app.state, U256::from(token), U256::from(tier)).await.unwrap();
    }
    // The same event seen twice (a backfill replay) counts once.
    indexer::on_mint(&app.state, U256::from(2), U256::from(1)).await.unwrap();
    let r = app.get("/api/tiers/stats", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json(), json!([{ "tier_id": 0, "minted": 1 }, { "tier_id": 1, "minted": 3 }]));
}

// ------------------------------------------------------------ rate limits & ideas

#[tokio::test]
async fn sign_in_is_rate_limited() {
    let app = app().await;
    let mut statuses = Vec::new();
    for _ in 0..20 {
        statuses.push(app.get("/api/auth/nonce", None).await.status);
    }
    assert!(statuses[..15].iter().all(|s| *s == StatusCode::OK), "burst allowed");
    let r = app.get("/api/auth/nonce", None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(r.headers.get("retry-after").is_some());
    // Other routes have their own budget.
    assert_eq!(app.get("/api/ideas", None).await.status, StatusCode::OK);
}

async fn sign_vote(signer: &PrivateKeySigner, idea: i64, choice: &str) -> Value {
    let issued_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let msg = etherdisk_server::ideas::vote_message(idea, choice, &signer.address(), issued_at);
    let sig = signer.sign_message(msg.as_bytes()).await.unwrap();
    json!({ "choice": choice, "issued_at": issued_at, "signature": format!("0x{}", alloy::hex::encode(sig.as_bytes())) })
}

#[tokio::test]
async fn ideas_board_one_vote_per_nft() {
    let app = app().await;
    let signers: Vec<PrivateKeySigner> = (0..5).map(|_| PrivateKeySigner::random()).collect();
    let [alice, bob, carol, admin, nobody] = <[PrivateKeySigner; 5]>::try_from(signers).unwrap();
    *app.chain.admin.lock().unwrap() = admin.address();
    app.mint(1, alice.address(), 1).await;
    app.mint(2, alice.address(), 1).await;
    app.mint(3, bob.address(), 1).await;
    app.mint(4, carol.address(), 1).await;
    let (ta, tb, tc) = (app.login(&alice).await, app.login(&bob).await, app.login(&carol).await);
    let (tadm, tn) = (app.login(&admin).await, app.login(&nobody).await);

    // Proposing needs a drive and a sane title.
    let propose = |t: String, title: &str| {
        let body = json!({ "title": title, "body": "details" });
        let app = &app;
        async move { app.json(Method::POST, "/api/ideas", Some(&t), body).await }
    };
    assert_eq!(propose(tn.clone(), "no drive").await.status, StatusCode::FORBIDDEN);
    assert_eq!(propose(tb.clone(), "  ").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(propose(tb.clone(), &"x".repeat(121)).await.status, StatusCode::BAD_REQUEST);
    let r = propose(tb.clone(), "Dark mode for the share page").await;
    assert_eq!(r.status, StatusCode::CREATED);
    let id = r.json()["id"].as_i64().unwrap();
    let id2 = propose(ta.clone(), "Russian translation").await.json()["id"].as_i64().unwrap();

    let vote = |t: String, body: Value, idea: i64| {
        let app = &app;
        async move { app.json(Method::POST, &format!("/api/ideas/{idea}/vote"), Some(&t), body).await }
    };
    let tally = |r: &Resp| (r.json()["votes_for"].as_i64().unwrap(), r.json()["votes_against"].as_i64().unwrap());

    // Authors don't vote on their own ideas (withdrawing is fine).
    assert_eq!(vote(tb.clone(), sign_vote(&bob, id, "for").await, id).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(vote(tb.clone(), sign_vote(&bob, id, "against").await, id).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(vote(tb.clone(), sign_vote(&bob, id, "withdraw").await, id).await.status, StatusCode::OK);

    // Alice holds two drives: her vote counts twice. Carol's counts once, against.
    let r = vote(ta.clone(), sign_vote(&alice, id, "for").await, id).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(tally(&r), (2, 0));
    assert_eq!(tally(&vote(tc.clone(), sign_vote(&carol, id, "against").await, id).await), (2, 1));
    // Voting again doesn't double count; changing sides moves the votes.
    assert_eq!(tally(&vote(ta.clone(), sign_vote(&alice, id, "for").await, id).await), (2, 1));
    assert_eq!(tally(&vote(ta.clone(), sign_vote(&alice, id, "against").await, id).await), (0, 3));
    assert_eq!(tally(&vote(ta.clone(), sign_vote(&alice, id, "for").await, id).await), (2, 1));
    assert_eq!(vote(ta.clone(), sign_vote(&alice, id, "maybe").await, id).await.status, StatusCode::BAD_REQUEST);
    // Signatures must be the caller's, for this idea and choice, and fresh.
    assert_eq!(vote(tb.clone(), sign_vote(&alice, id2, "for").await, id2).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(vote(tb.clone(), sign_vote(&bob, id, "for").await, id2).await.status, StatusCode::BAD_REQUEST);
    let mut stale = sign_vote(&bob, id2, "for").await;
    stale["issued_at"] = json!(1_000_000);
    assert_eq!(vote(tb.clone(), stale, id2).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(vote(tn.clone(), sign_vote(&nobody, id, "for").await, id).await.status, StatusCode::FORBIDDEN);

    let list = app.get("/api/ideas", None).await.json();
    assert_eq!(list[0]["id"], id, "best score first");
    assert_eq!((list[0]["votes_for"].clone(), list[0]["votes_against"].clone()), (json!(2), json!(1)));
    let me = app.get("/api/ideas/me", Some(&ta)).await.json();
    assert_eq!((me["tokens"].as_u64(), me["admin"].as_bool()), (Some(2), Some(false)));
    assert_eq!(me["votes"], json!({ id.to_string(): "for" }));
    assert_eq!(app.get("/api/ideas/me", Some(&tc)).await.json()["votes"], json!({ id.to_string(): "against" }));
    // Everyone can audit the signatures.
    let audit = app.get(&format!("/api/ideas/{id}/votes"), None).await.json();
    assert_eq!(audit.as_array().unwrap().len(), 3);
    assert!(audit[0]["message"].as_str().unwrap().starts_with("Etherdisk vote"));
    assert_eq!(audit.as_array().unwrap().iter().filter(|v| v["choice"] == "against").count(), 1);

    // A transfer clears the token's votes: carol buys token 2, alice keeps one vote, and
    // carol's own vote still counts once.
    app.chain.transfer(2, carol.address());
    indexer::on_transfer(&app.state, alice.address(), carol.address(), U256::from(2)).await.unwrap();
    let list = app.get("/api/ideas", None).await.json();
    assert_eq!((list[0]["votes_for"].clone(), list[0]["votes_against"].clone()), (json!(1), json!(1)));
    assert_eq!(app.get("/api/ideas/me", Some(&tc)).await.json()["votes"], json!({ id.to_string(): "against" }));
    // Votes of a token that moved while the server wasn't clearing them go at startup.
    app.chain.transfer(1, bob.address());
    assert_eq!(etherdisk_server::ideas::drop_stale_votes(&app.state).await.unwrap(), 1);
    assert_eq!(app.get("/api/ideas/me", Some(&tb)).await.json()["votes"], json!({}), "bob doesn't inherit a vote on his own idea");
    assert_eq!(etherdisk_server::ideas::drop_stale_votes(&app.state).await.unwrap(), 0);
    assert_eq!(tally(&vote(tc.clone(), sign_vote(&carol, id, "withdraw").await, id).await), (0, 0));

    // Moderation: only the admin; hidden ideas disappear for everyone else.
    let patch = |t: String, body: Value| {
        let app = &app;
        async move { app.json(Method::PATCH, &format!("/api/ideas/{id2}"), Some(&t), body).await.status }
    };
    assert_eq!(patch(tb.clone(), json!({ "status": "done" })).await, StatusCode::FORBIDDEN);
    assert_eq!(patch(tadm.clone(), json!({ "status": "nonsense" })).await, StatusCode::BAD_REQUEST);
    assert_eq!(patch(tadm.clone(), json!({ "status": "planned" })).await, StatusCode::NO_CONTENT);
    let list = app.get("/api/ideas", None).await.json();
    assert_eq!(list.as_array().unwrap().iter().find(|i| i["id"] == id2).unwrap()["status"], "planned");
    assert_eq!(patch(tadm.clone(), json!({ "hidden": true })).await, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/ideas", None).await.json().as_array().unwrap().len(), 1);
    assert_eq!(app.get("/api/ideas", Some(&tadm)).await.json().as_array().unwrap().len(), 2, "the admin still sees it");
    assert_eq!(vote(tb.clone(), sign_vote(&bob, id2, "for").await, id2).await.status, StatusCode::NOT_FOUND);
    assert!(app.get("/api/ideas/me", Some(&tadm)).await.json()["admin"].as_bool().unwrap());
}

#[tokio::test]
async fn configured_wallets_moderate_ideas_besides_the_contract_owner() {
    let (moderator, author, stranger) = (PrivateKeySigner::random(), PrivateKeySigner::random(), PrivateKeySigner::random());
    let app = app_with(|c| c.ideas_admins = vec![moderator.address()]).await;
    // The contract owner is someone else (a multisig, say).
    *app.chain.admin.lock().unwrap() = Address::repeat_byte(0x5a);
    app.mint(1, author.address(), 1).await;
    let (tm, ta, ts) = (app.login(&moderator).await, app.login(&author).await, app.login(&stranger).await);
    let id = app.json(Method::POST, "/api/ideas", Some(&ta), json!({ "title": "Dark mode" })).await.json()["id"].as_i64().unwrap();

    assert!(app.get("/api/ideas/me", Some(&tm)).await.json()["admin"].as_bool().unwrap());
    assert!(!app.get("/api/ideas/me", Some(&ts)).await.json()["admin"].as_bool().unwrap());
    let patch = |t: String| {
        let app = &app;
        async move { app.json(Method::PATCH, &format!("/api/ideas/{id}"), Some(&t), json!({ "hidden": true })).await.status }
    };
    assert_eq!(patch(ts.clone()).await, StatusCode::FORBIDDEN);
    assert_eq!(patch(tm.clone()).await, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/ideas", Some(&tm)).await.json().as_array().unwrap().len(), 1, "a moderator sees hidden ideas");
    assert_eq!(app.get("/api/ideas", Some(&ts)).await.json().as_array().unwrap().len(), 0);
}

// ------------------------------------------------------------ key rotation

#[tokio::test]
async fn a_new_owner_is_asked_for_a_new_key() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let ta = app.login(&alice).await;
    let (vault, _, _) = setup_vault_with_file(&app, &ta, b"x").await;
    let key = app.get("/api/vaults/1/key", Some(&ta)).await.json();
    assert_eq!((key["needs_new_key"].as_bool(), key["keyring"].is_null()), (Some(false), true), "the maker's own key");

    // Alice saves a recovery key, then the drive moves to bob.
    let rblob = vault.wrap_for_recovery(&etherdisk_crypto::RecoveryKey::generate().unwrap()).unwrap();
    app.json(Method::PUT, "/api/vaults/1/recovery", Some(&ta), json!({ "blob": b64(&rblob) })).await;
    app.chain.transfer(1, bob.address());
    let tb = app.login(&bob).await;
    let key = app.get("/api/vaults/1/key", Some(&tb)).await.json();
    assert_eq!(key["needs_new_key"], true);
    let etag = key["etag"].as_str().unwrap().to_owned();

    // Bob makes a new key: it must come with its keyring, and replaces the blob atomically.
    let next = vault.rotate().unwrap();
    let new_blob = next.rewrap("bob's own").unwrap();
    let ring = next.seal_keyring().unwrap();
    let put = |body: Value| {
        let app = &app;
        let tb = tb.clone();
        async move { app.json(Method::PUT, "/api/vaults/1/key", Some(&tb), body).await }
    };
    assert_eq!(put(json!({ "key_blob": b64(&new_blob), "previous_etag": etag, "rotate": true })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(put(json!({ "key_blob": b64(&new_blob), "previous_etag": etag, "keyring": b64(&ring) })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        put(json!({ "key_blob": b64(&new_blob), "previous_etag": "stale", "rotate": true, "keyring": b64(&ring) })).await.status,
        StatusCode::CONFLICT
    );
    let r = put(json!({ "key_blob": b64(&new_blob), "previous_etag": etag, "rotate": true, "keyring": b64(&ring) })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    let key = app.get("/api/vaults/1/key", Some(&tb)).await.json();
    assert_eq!((key["needs_new_key"].as_bool(), key["keyring"].clone()), (Some(false), json!(b64(&ring))));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_recovery").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0, "a recovery key of the old drive key is gone");

    // A passphrase change keeps the keyring; the drive back at alice's asks her again.
    let r = put(json!({ "key_blob": b64(&next.rewrap("again").unwrap()), "previous_etag": key["etag"] })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(app.get("/api/vaults/1/key", Some(&tb)).await.json()["keyring"], json!(b64(&ring)));
    app.chain.transfer(1, alice.address());
    assert_eq!(app.get("/api/vaults/1/key", Some(&ta)).await.json()["needs_new_key"], true);
}

// ------------------------------------------------------------ drive lists

#[tokio::test]
async fn drive_lists_follow_transfer_events_and_ownerof() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(2, alice.address(), 1).await;
    app.mint(10, alice.address(), 4).await;
    let (ta, tb) = (app.login(&alice).await, app.login(&bob).await);
    let ids = |v: Value| v.as_array().unwrap().iter().map(|d| d["token_id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(ids(app.get("/api/vaults", Some(&ta)).await.json()), ["2", "10"], "by number, not as text");

    // The token moves on chain before the indexer sees it: alice stops seeing it at once
    // (ownerOf), bob sees it once the event is processed.
    app.chain.transfer(10, bob.address());
    assert_eq!(ids(app.get("/api/vaults", Some(&ta)).await.json()), ["2"]);
    assert!(ids(app.get("/api/vaults", Some(&tb)).await.json()).is_empty());
    indexer::on_transfer(&app.state, alice.address(), bob.address(), U256::from(10)).await.unwrap();
    assert_eq!(ids(app.get("/api/vaults", Some(&tb)).await.json()), ["10"]);

    // A drive just minted: opening it (ownerOf checked) lists it without waiting for the indexer.
    app.chain.mint(11, bob.address(), 1);
    assert_eq!(ids(app.get("/api/vaults", Some(&tb)).await.json()), ["10"]);
    assert_eq!(app.get("/api/vaults/11", Some(&tb)).await.status, StatusCode::OK);
    assert_eq!(ids(app.get("/api/vaults", Some(&tb)).await.json()), ["10", "11"]);
    // Someone else's drive can't be claimed that way.
    assert_eq!(app.get("/api/vaults/2", Some(&tb)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(ids(app.get("/api/vaults", Some(&tb)).await.json()), ["10", "11"]);
}

// ------------------------------------------------------------ recovery key

#[tokio::test]
async fn recovery_key_is_per_holder_and_dropped_on_transfer() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let ta = app.login(&alice).await;
    let url = "/api/vaults/1/recovery";
    let key = etherdisk_crypto::RecoveryKey::generate().unwrap();
    let put = |t: String, blob: Vec<u8>| {
        let app = &app;
        async move { app.json(Method::PUT, url, Some(&t), json!({ "blob": b64(&blob) })).await.status }
    };

    // Only for a set-up drive, and only a well-formed blob.
    let (scratch, _) = Vault::create_with_params("x", FAST).unwrap();
    assert_eq!(put(ta.clone(), scratch.wrap_for_recovery(&key).unwrap()).await, StatusCode::CONFLICT);
    let (vault, _, _) = setup_vault_with_file(&app, &ta, b"x").await;
    let blob = vault.wrap_for_recovery(&key).unwrap();
    assert_eq!(put(ta.clone(), blob[1..].to_vec()).await, StatusCode::BAD_REQUEST);
    assert_eq!(app.get(url, Some(&ta)).await.status, StatusCode::NOT_FOUND);
    assert!(app.get("/api/vaults/1", Some(&ta)).await.json()["recovery_at"].is_null());

    assert_eq!(put(ta.clone(), blob.clone()).await, StatusCode::OK);
    let r = app.get(url, Some(&ta)).await.json();
    assert_eq!(r["blob"], b64(&blob));
    assert!(r["created_at"].as_i64().unwrap() > 0);
    assert_eq!(app.get("/api/vaults/1", Some(&ta)).await.json()["recovery_at"], r["created_at"]);

    // Bob owns no drive here: he gets nothing.
    let tb = app.login(&bob).await;
    assert_eq!(app.get(url, Some(&tb)).await.status, StatusCode::FORBIDDEN);

    // After a transfer alice can't read it, and bob doesn't see alice's key as his.
    app.chain.transfer(1, bob.address());
    assert_eq!(app.get(url, Some(&ta)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get(url, Some(&tb)).await.status, StatusCode::NOT_FOUND);
    assert!(app.get("/api/vaults/1", Some(&tb)).await.json()["recovery_at"].is_null());
    // Bob saves his own before the indexer catches up: the transfer keeps it.
    let bobs = vault.wrap_for_recovery(&etherdisk_crypto::RecoveryKey::generate().unwrap()).unwrap();
    assert_eq!(put(tb.clone(), bobs.clone()).await, StatusCode::OK);
    indexer::on_transfer(&app.state, alice.address(), bob.address(), U256::from(1)).await.unwrap();
    assert_eq!(app.get(url, Some(&tb)).await.json()["blob"], b64(&bobs));

    // A transfer back to alice drops bob's key.
    app.chain.transfer(1, alice.address());
    indexer::on_transfer(&app.state, bob.address(), alice.address(), U256::from(1)).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_recovery").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0);

    // Deleting, and formatting the drive, remove it too.
    assert_eq!(put(ta.clone(), blob.clone()).await, StatusCode::OK);
    assert_eq!(app.req(Method::DELETE, url, Some(&ta), Body::empty(), "", &[]).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(url, Some(&ta)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(put(ta.clone(), blob).await, StatusCode::OK);
    app.json(Method::POST, "/api/vaults/1/reset", Some(&ta), json!({ "confirm": "DELETE" })).await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_recovery").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0);
}

// ------------------------------------------------------------ key handover

/// Publishes `signer`'s inbox key the way the browser does; returns the key.
async fn publish_inbox(app: &App, token: &str, signer: &PrivateKeySigner, seed: u8) -> Vec<u8> {
    let key = etherdisk_crypto::inbox::InboxSecret::from_signature(&[seed; 65]).unwrap().public().to_vec();
    let msg = etherdisk_server::handover::inbox_message(&signer.address(), &key);
    let sig = signer.sign_message(msg.as_bytes()).await.unwrap();
    let r = app
        .json(Method::PUT, "/api/inbox", Some(token), json!({ "pubkey": b64(&key), "signature": format!("0x{}", alloy::hex::encode(sig.as_bytes())) }))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", String::from_utf8_lossy(&r.body));
    key
}

#[tokio::test]
async fn inbox_keys_are_bound_to_the_wallet() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    let tb = app.login(&bob).await;
    let key = publish_inbox(&app, &tb, &bob, 1).await;
    let r = app.get(&format!("/api/inbox/{}", bob.address()), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["pubkey"], b64(&key));

    // A signature by someone else over bob's message is refused.
    let msg = etherdisk_server::handover::inbox_message(&bob.address(), &key);
    let forged = alice.sign_message(msg.as_bytes()).await.unwrap();
    let r = app
        .json(Method::PUT, "/api/inbox", Some(&tb), json!({ "pubkey": b64(&key), "signature": format!("0x{}", alloy::hex::encode(forged.as_bytes())) }))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.get(&format!("/api/inbox/{}", alice.address()), None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn drive_key_handover() {
    let app = app().await;
    let (alice, bob, carol, dave) = (PrivateKeySigner::random(), PrivateKeySigner::random(), PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let ta = app.login(&alice).await;
    setup_vault_with_file(&app, &ta, b"x").await;
    let sealed = b64(&[9u8; etherdisk_server::handover::SEALED_LEN]);
    let seal = |t: String, to: Address| {
        let sealed = sealed.clone();
        let app = &app;
        async move { app.json(Method::POST, "/api/vaults/1/handover", Some(&t), json!({ "to": to, "sealed": sealed })).await.status }
    };

    // 1. In-app transfer: alice seals the key for bob before transferring.
    assert_eq!(seal(ta.clone(), alice.address()).await, StatusCode::BAD_REQUEST, "to yourself");
    let bad = app.json(Method::POST, "/api/vaults/1/handover", Some(&ta), json!({ "to": bob.address(), "sealed": "AAAA" })).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "wrong size");
    assert_eq!(seal(ta.clone(), bob.address()).await, StatusCode::NO_CONTENT);
    app.chain.transfer(1, bob.address());
    indexer::on_transfer(&app.state, alice.address(), bob.address(), U256::from(1)).await.unwrap();
    let tb = app.login(&bob).await;
    let h = app.get("/api/vaults/1/handover", Some(&tb)).await.json();
    assert_eq!(h["from"], format!("{:#x}", alice.address()));
    assert_eq!(h["sealed"], sealed, "the indexer keeps a key sealed for this exact recipient");
    // Alice no longer owns it: she can't read it, and nothing is outgoing for her.
    assert_eq!(app.get("/api/vaults/1/handover", Some(&ta)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/handovers/outgoing", Some(&ta)).await.json().as_array().unwrap().len(), 0);
    assert_eq!(app.req(Method::DELETE, "/api/vaults/1/handover", Some(&tb), Body::empty(), "", &[]).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/vaults/1/handover", Some(&tb)).await.status, StatusCode::NOT_FOUND);

    // 2. Transfer outside the app: bob is asked for the key, carol waits for it.
    app.chain.transfer(1, carol.address());
    indexer::on_transfer(&app.state, bob.address(), carol.address(), U256::from(1)).await.unwrap();
    let tc = app.login(&carol).await;
    assert!(app.get("/api/vaults/1/handover", Some(&tc)).await.json()["sealed"].is_null());
    let out = app.get("/api/handovers/outgoing", Some(&tb)).await.json();
    assert_eq!(out[0]["token_id"], "1");
    assert_eq!(out[0]["to"], format!("{:#x}", carol.address()));
    assert!(out[0]["key_blob"].is_string(), "bob may unlock the unchanged blob with his passphrase");
    assert!(out[0]["recipient"].is_null(), "carol has no inbox yet");
    let key = publish_inbox(&app, &tc, &carol, 2).await;
    assert_eq!(app.get("/api/handovers/outgoing", Some(&tb)).await.json()[0]["recipient"]["pubkey"], b64(&key));
    // Only the previous owner, only for the current owner.
    assert_eq!(seal(ta.clone(), carol.address()).await, StatusCode::FORBIDDEN);
    assert_eq!(seal(tb.clone(), dave.address()).await, StatusCode::FORBIDDEN);
    assert_eq!(seal(tb.clone(), carol.address()).await, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/vaults/1/handover", Some(&tc)).await.json()["sealed"], sealed);
    assert_eq!(app.get("/api/handovers/outgoing", Some(&tb)).await.json().as_array().unwrap().len(), 0);

    // 3. Once the new owner sets their own passphrase, the old owner no longer gets the blob
    //    (it is now protected by the new owner's passphrase).
    app.chain.transfer(1, dave.address());
    indexer::on_transfer(&app.state, carol.address(), dave.address(), U256::from(1)).await.unwrap();
    let td = app.login(&dave).await;
    let k = app.get("/api/vaults/1/key", Some(&td)).await.json();
    let (_, blob) = Vault::create_with_params("dave's", FAST).unwrap();
    let r = app.json(Method::PUT, "/api/vaults/1/key", Some(&td), json!({ "key_blob": b64(&blob), "previous_etag": k["etag"] })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(app.get("/api/handovers/outgoing", Some(&tc)).await.json()[0]["key_blob"].is_null());

    // Declining removes the request; formatting the drive removes any handover.
    assert_eq!(app.req(Method::DELETE, "/api/handovers/outgoing/1", Some(&tc), Body::empty(), "", &[]).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/vaults/1/handover", Some(&td)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(seal(td.clone(), carol.address()).await, StatusCode::NO_CONTENT);
    app.json(Method::POST, "/api/vaults/1/reset", Some(&td), json!({ "confirm": "DELETE" })).await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM handovers").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn transfer_without_the_key_asks_for_nothing() {
    let app = app().await;
    let (alice, bob, carol) = (PrivateKeySigner::random(), PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let ta = app.login(&alice).await;
    setup_vault_with_file(&app, &ta, b"x").await;

    // Alice transfers in the app with "send the key" unchecked: the indexer asks for nothing.
    assert_eq!(app.json(Method::POST, "/api/vaults/1/handover/skip", Some(&ta), json!({ "to": bob.address() })).await.status, StatusCode::NO_CONTENT);
    app.chain.transfer(1, bob.address());
    indexer::on_transfer(&app.state, alice.address(), bob.address(), U256::from(1)).await.unwrap();
    let tb = app.login(&bob).await;
    assert_eq!(app.get("/api/vaults/1/handover", Some(&tb)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/handovers/outgoing", Some(&ta)).await.json().as_array().unwrap().len(), 0);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM handover_skips").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0, "the skip is used up");

    // Only the owner can skip; a skip for another recipient doesn't cover this transfer.
    assert_eq!(app.json(Method::POST, "/api/vaults/1/handover/skip", Some(&ta), json!({ "to": carol.address() })).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/handover/skip", Some(&tb), json!({ "to": alice.address() })).await.status, StatusCode::NO_CONTENT);
    app.chain.transfer(1, carol.address());
    indexer::on_transfer(&app.state, bob.address(), carol.address(), U256::from(1)).await.unwrap();
    let tc = app.login(&carol).await;
    assert_eq!(app.get("/api/vaults/1/handover", Some(&tc)).await.status, StatusCode::OK);
}

// ------------------------------------------------------------ shares & transfer

#[tokio::test]
async fn share_links_and_transfer_revocation() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.mint(1, alice.address(), 1).await;
    let ta = app.login(&alice).await;
    let (vault, shared, ct) = setup_vault_with_file(&app, &ta, b"shared content").await;
    let (private, _) = upload(&app, &ta, &vault, None, b"private").await;

    let r = app
        .json(Method::POST, "/api/vaults/1/shares", Some(&ta), json!({
            "object_ids": [shared], "manifest": b64(b"encrypted manifest"), "owner_metadata": "AA=="
        }))
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let sid = r.json()["id"].as_str().unwrap().to_owned();

    // Anonymous recipient.
    assert_eq!(STANDARD.decode(app.get(&format!("/api/shares/{sid}"), None).await.json()["manifest"].as_str().unwrap()).unwrap(), b"encrypted manifest");
    assert_eq!(app.get(&format!("/api/shares/{sid}/files/{shared}/content"), None).await.body, ct);
    assert_eq!(app.get(&format!("/api/shares/{sid}/files/{private}/content"), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/vaults/1/shares", Some(&ta)).await.json()[0]["file_count"], 1);

    // Only files of this vault can be shared.
    let r = app
        .json(Method::POST, "/api/vaults/1/shares", Some(&ta), json!({
            "object_ids": [Uuid::new_v4()], "manifest": "AA==", "owner_metadata": "AA=="
        }))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Transfer to Bob. Even before the indexer runs, the link and Alice's access are gone.
    app.chain.transfer(1, bob.address());
    assert_eq!(app.get(&format!("/api/shares/{sid}"), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/vaults/1/objects", Some(&ta)).await.status, StatusCode::FORBIDDEN);

    // Bob gets the files and the key blob intact; the passphrase from Alice unlocks them.
    let tb = app.login(&bob).await;
    let key = app.get("/api/vaults/1/key", Some(&tb)).await.json();
    let unlocked = Vault::unlock(&STANDARD.decode(key["key_blob"].as_str().unwrap()).unwrap(), "pass").unwrap();
    let got = app.get(&format!("/api/vaults/1/files/{shared}/content"), Some(&tb)).await.body;
    let fk = unlocked.file_key(&FileHeader::parse(&got).unwrap().file_salt);
    assert_eq!(etherdisk_crypto::decrypt_file(&fk, &got).unwrap(), b"shared content");
    assert_eq!(app.get("/api/vaults/1/shares", Some(&tb)).await.json().as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn indexer_revokes_links_on_transfer_event() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (_, f, _) = setup_vault_with_file(&app, &t, b"x").await;
    let body = json!({ "object_ids": [f], "manifest": "AA==", "owner_metadata": "AA==" });
    let sid = app.json(Method::POST, "/api/vaults/1/shares", Some(&t), body).await.json()["id"].as_str().unwrap().to_owned();

    // Mint events (from = 0) leave links alone.
    indexer::on_transfer(&app.state, Address::ZERO, alice.address(), U256::from(1)).await.unwrap();
    assert_eq!(app.get(&format!("/api/shares/{sid}"), None).await.status, StatusCode::OK);

    // A -> B -> A before anyone opened the link: the owner check alone would let it live again.
    indexer::on_transfer(&app.state, alice.address(), Address::repeat_byte(0xbb), U256::from(1)).await.unwrap();
    assert_eq!(app.get(&format!("/api/shares/{sid}"), None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reset_wipes_everything() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.mint(1, alice.address(), 1).await;
    let t = app.login(&alice).await;
    let (_, f, _) = setup_vault_with_file(&app, &t, b"gone").await;

    assert_eq!(app.json(Method::POST, "/api/vaults/1/reset", Some(&t), json!({ "confirm": "yes" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.json(Method::POST, "/api/vaults/1/reset", Some(&t), json!({ "confirm": "DELETE" })).await.status, StatusCode::NO_CONTENT);

    let info = app.get("/api/vaults/1", Some(&t)).await.json();
    assert_eq!(info["initialized"], false);
    assert_eq!(info["used_bytes"], 0);
    assert_eq!(app.get(&format!("/api/vaults/1/files/{f}/content"), Some(&t)).await.status, StatusCode::NOT_FOUND);
    assert!(!app.data_dir.path().join("blobs").join("1").exists());

    // A new passphrase can be set right away.
    let (_, blob) = Vault::create_with_params("new", FAST).unwrap();
    let r = app.json(Method::PUT, "/api/vaults/1/key", Some(&t), json!({ "key_blob": b64(&blob), "previous_etag": null })).await;
    assert_eq!(r.status, StatusCode::OK);
}
