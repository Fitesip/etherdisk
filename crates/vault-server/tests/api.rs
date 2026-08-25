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
use vault_server::{bind_deployment, connect_db, indexer, AppState, Config};

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
    app.chain.mint(1, alice.address(), 1);
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
    app.chain.mint(1, alice.address(), 1);
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
    app.chain.mint(1, alice.address(), 1);
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

// ------------------------------------------------------------ key handover

/// Publishes `signer`'s inbox key the way the browser does; returns the key.
async fn publish_inbox(app: &App, token: &str, signer: &PrivateKeySigner, seed: u8) -> Vec<u8> {
    let key = vault_crypto::inbox::InboxSecret::from_signature(&[seed; 65]).unwrap().public().to_vec();
    let msg = vault_server::handover::inbox_message(&signer.address(), &key);
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
    let msg = vault_server::handover::inbox_message(&bob.address(), &key);
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
    app.chain.mint(1, alice.address(), 1);
    let ta = app.login(&alice).await;
    setup_vault_with_file(&app, &ta, b"x").await;
    let sealed = b64(&[9u8; vault_server::handover::SEALED_LEN]);
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
