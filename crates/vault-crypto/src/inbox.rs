//! Inbox: hands a drive key to its next owner without the server seeing it.
//!
//! The recipient derives an X25519 key pair from a wallet signature over a fixed message
//! (wallets sign deterministically, so signing again recovers the same key) and publishes
//! the public half. A sender seals data to it: ephemeral X25519 + HKDF-SHA256 +
//! XChaCha20-Poly1305. Output: ephemeral public key (32) | nonce (24) | ciphertext.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{Error, Result};

const NONCE_LEN: usize = 24;
pub const INBOX_PUBLIC_LEN: usize = 32;
/// Overhead of `seal` over the plaintext.
pub const SEALED_OVERHEAD: usize = INBOX_PUBLIC_LEN + NONCE_LEN + 16;

/// The recipient's secret, re-derived from the same wallet signature when needed.
pub struct InboxSecret(StaticSecret);

impl InboxSecret {
    /// Derives the key from a wallet signature over the inbox message.
    pub fn from_signature(signature: &[u8]) -> Result<Self> {
        if signature.len() < 64 {
            return Err(Error::Argument("signature too short"));
        }
        let mut h = Sha256::new();
        h.update(b"nft-vault/inbox/v1");
        h.update(signature);
        let seed = Zeroizing::new(<[u8; 32]>::from(h.finalize()));
        Ok(Self(StaticSecret::from(*seed)))
    }

    pub fn public(&self) -> [u8; INBOX_PUBLIC_LEN] {
        PublicKey::from(&self.0).to_bytes()
    }

    /// Opens data sealed to this inbox. `aad` must match what the sender used.
    pub fn open(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() < SEALED_OVERHEAD {
            return Err(Error::Format("sealed data too short"));
        }
        let (eph, rest) = sealed.split_at(INBOX_PUBLIC_LEN);
        let (nonce, ct) = rest.split_at(NONCE_LEN);
        let eph = PublicKey::from(<[u8; 32]>::try_from(eph).unwrap());
        let key = seal_key(&self.0.diffie_hellman(&eph), eph.as_bytes(), &self.public())?;
        XChaCha20Poly1305::new(Key::from_slice(&key[..]))
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
            .map_err(|_| Error::Auth)
    }
}

fn seal_key(shared: &x25519_dalek::SharedSecret, eph: &[u8; 32], recipient: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    // A low-order point gives an all-zero secret: refuse instead of encrypting under it.
    if !shared.was_contributory() {
        return Err(Error::Argument("invalid public key"));
    }
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph);
    salt[32..].copy_from_slice(recipient);
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
        .expand(b"nft-vault/inbox-seal/v1", &mut key[..])
        .map_err(|_| Error::Argument("hkdf"))?;
    Ok(key)
}

/// Encrypts `plaintext` so only the holder of `recipient`'s inbox secret can read it.
pub fn seal(recipient: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let recipient: [u8; 32] = recipient.try_into().map_err(|_| Error::Argument("public key must be 32 bytes"))?;
    let mut eph_seed = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut eph_seed[..]).map_err(|_| Error::Rng)?;
    let eph = StaticSecret::from(*eph_seed);
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let key = seal_key(&eph.diffie_hellman(&PublicKey::from(recipient)), &eph_pub, &recipient)?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| Error::Rng)?;
    let ct = XChaCha20Poly1305::new(Key::from_slice(&key[..]))
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| Error::Auth)?;
    let mut out = Vec::with_capacity(SEALED_OVERHEAD + plaintext.len());
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}
