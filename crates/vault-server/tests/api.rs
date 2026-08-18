//! End-to-end API tests against an in-memory chain, real SIWE signatures and real
//! vault-crypto ciphertext.

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

use vault_crypto::{encrypt_file, FileHeader, KdfParams, Vault};
use vault_server::chain::{Chain, Ownership};
use vault_server::storage::LocalStore;
use vault_server::{connect_db, indexer, AppState, Config};

// ------------------------------------------------------------ fixtures

#[derive(Default)]
struct FakeChain {
    tokens: Mutex<HashMap<U256, (Address, u32)>>,
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
    async fn tokens_of_owner(&self, owner: Address) -> anyhow::Result<Vec<U256>> {
        let mut ids: Vec<U256> =
            self.tokens.lock().unwrap().iter().filter(|(_, t)| t.0 == owner).map(|(id, _)| *id).collect();
        ids.sort();
        Ok(ids)
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
    let data_dir = tempfile::tempdir().unwrap();
    let config = Config {
        bind_addr: String::new(),
        database_url: format!("sqlite://{}", data_dir.path().join("test.db").display()),
        data_dir: data_dir.path().join("blobs"),
        rpc_url: String::new(),
        contract_address: Address::ZERO,
        chain_id: CHAIN_ID,
        start_block: 0,
        log_block_range: 500,
        confirmations: 0,
        siwe_domain: DOMAIN.into(),
        cors_origins: vec![],
        session_ttl_secs: 3600,
    };
    let db = connect_db(&config.database_url).await.unwrap();
    let store = Arc::new(LocalStore::new(&config.data_dir).unwrap());
    let chain = Arc::new(FakeChain::default());
    // TTL 0: every request sees the fake chain's current state.
    let state = AppState::new(db, store, Ownership::new(chain.clone(), Duration::ZERO), config);
    App { router: vault_server::router(state.clone()), state, chain, data_dir }
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
        "{domain} wants you to sign in with your Ethereum account:\n{}\n\nSign in to NFT Vault\n\n\
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
    app.chain.mint(1, alice.address(), 1);
    app.chain.mint(2, alice.address(), 4);
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
    app.chain.mint(1, alice.address(), 1);
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
    assert_eq!(vault_crypto::decrypt_file(&vault.file_key(&FileHeader::parse(&full.body).unwrap().file_salt), &full.body).unwrap(), plain);

    // One encrypted chunk via Range, decrypted on its own (what video seeking does).
    let loc = vault_crypto::chunk_location(3, 64, ct.len() as u64).unwrap();
    let range = format!("bytes={}-{}", loc.offset, loc.offset + loc.len - 1);
    let part = app
        .req(Method::GET, &format!("/api/vaults/1/files/{id}/content"), Some(&t), Body::empty(), "", &[("range", &range)])
        .await;
    assert_eq!(part.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.headers[header::CONTENT_RANGE], format!("bytes {}-{}/{}", loc.offset, loc.offset + loc.len - 1, ct.len()));
    let dec = vault_crypto::FileDecryptor::new(&vault.file_key(&FileHeader::parse(&ct).unwrap().file_salt), &ct).unwrap();
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
    app.chain.mint(1, alice.address(), 1);
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

    // Pending files are invisible and not downloadable.
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
    app.chain.mint(1, alice.address(), 1);
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
    app.chain.mint(1, alice.address(), 1);
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
    assert!(!blob_path.exists());
    assert_eq!(app.get("/api/vaults/1/objects", Some(t)).await.json().as_array().unwrap().len(), 0);
    assert_eq!(app.get("/api/vaults/1", Some(t)).await.json()["used_bytes"], 0);
}

#[tokio::test]
async fn folder_path_for_breadcrumbs() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.chain.mint(1, alice.address(), 1);
    app.chain.mint(2, alice.address(), 1);
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
    app.chain.mint(1, alice.address(), 1);
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

    let tb = app.login(&bob).await;
    assert_eq!(app.json(Method::PUT, "/api/vaults/1/profile", Some(&tb), json!({ "name": "mine" })).await.status, StatusCode::FORBIDDEN);
}

// ------------------------------------------------------------ shares & transfer

#[tokio::test]
async fn share_links_and_transfer_revocation() {
    let app = app().await;
    let (alice, bob) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    app.chain.mint(1, alice.address(), 1);
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
    assert_eq!(vault_crypto::decrypt_file(&fk, &got).unwrap(), b"shared content");
    assert_eq!(app.get("/api/vaults/1/shares", Some(&tb)).await.json().as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn indexer_revokes_links_on_transfer_event() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.chain.mint(1, alice.address(), 1);
    let t = app.login(&alice).await;
    let (_, f, _) = setup_vault_with_file(&app, &t, b"x").await;
    let body = json!({ "object_ids": [f], "manifest": "AA==", "owner_metadata": "AA==" });
    let sid = app.json(Method::POST, "/api/vaults/1/shares", Some(&t), body).await.json()["id"].as_str().unwrap().to_owned();

    // Mint events (from = 0) leave links alone.
    indexer::on_transfer(&app.state, Address::ZERO, U256::from(1)).await.unwrap();
    assert_eq!(app.get(&format!("/api/shares/{sid}"), None).await.status, StatusCode::OK);

    // A -> B -> A before anyone opened the link: the owner check alone would let it live again.
    indexer::on_transfer(&app.state, alice.address(), U256::from(1)).await.unwrap();
    assert_eq!(app.get(&format!("/api/shares/{sid}"), None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reset_wipes_everything() {
    let app = app().await;
    let alice = PrivateKeySigner::random();
    app.chain.mint(1, alice.address(), 1);
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
