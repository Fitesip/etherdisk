use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::file::FileKey;
use crate::recovery::RecoveryKey;
use crate::{Error, Result};

const BLOB_MAGIC: &[u8; 4] = b"NVK1";
const BLOB_VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 4 + 1 + 12 + SALT_LEN; // magic, version, kdf params, salt (authenticated as AAD)
const WRAPPED_DEK_LEN: usize = 32 + 16;

/// Size of the serialized wrapped-DEK blob stored on the server.
pub const KEY_BLOB_LEN: usize = HEADER_LEN + NONCE_LEN + WRAPPED_DEK_LEN;

const RECOVERY_MAGIC: &[u8; 4] = b"EDR1";
const RECOVERY_VERSION: u8 = 1;
const RECOVERY_HEADER_LEN: usize = 4 + 1; // magic, version (authenticated as AAD)

/// Size of the DEK wrapped under a recovery key (`Vault::wrap_for_recovery`).
pub const RECOVERY_BLOB_LEN: usize = RECOVERY_HEADER_LEN + NONCE_LEN + WRAPPED_DEK_LEN;

pub(crate) fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|_| Error::Rng)?;
    Ok(b)
}

/// Argon2id parameters. Stored in the key blob, so they can be raised later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub parallelism: u32,
}

impl KdfParams {
    /// 64 MiB, 3 passes, 1 lane (WASM has no threads).
    pub const DEFAULT: Self = Self { m_cost_kib: 64 * 1024, t_cost: 3, parallelism: 1 };

    // Upper bounds protect the client from a hostile server sending a blob that
    // asks for gigabytes of memory.
    const MAX_M_KIB: u32 = 1024 * 1024;
    const MAX_T: u32 = 16;
    const MAX_P: u32 = 16;

    /// At least the defaults, component-wise. A key blob's parameters are only authenticated
    /// once it unlocks; a blob that is just read for its parameters (recovery, a handed-over
    /// key) may come from a hostile server that wants the new passphrase wrapped weakly.
    fn at_least_default(self) -> Self {
        Self {
            m_cost_kib: self.m_cost_kib.max(Self::DEFAULT.m_cost_kib),
            t_cost: self.t_cost.max(Self::DEFAULT.t_cost),
            parallelism: self.parallelism.max(Self::DEFAULT.parallelism),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.m_cost_kib > Self::MAX_M_KIB || self.t_cost > Self::MAX_T || self.parallelism > Self::MAX_P {
            return Err(Error::Format("kdf parameters out of range"));
        }
        Ok(())
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct Dek([u8; 32]);

/// An unlocked vault: holds the data-encryption key in memory (zeroized on drop).
pub struct Vault {
    dek: Dek,
    params: KdfParams,
}

/// Validates a key blob header and returns its KDF parameters.
fn blob_params(blob: &[u8]) -> Result<KdfParams> {
    if blob.len() != KEY_BLOB_LEN || &blob[..4] != BLOB_MAGIC {
        return Err(Error::Format("bad key blob"));
    }
    if blob[4] != BLOB_VERSION {
        return Err(Error::Format("unsupported key blob version"));
    }
    let u32_at = |i: usize| u32::from_le_bytes(blob[i..i + 4].try_into().unwrap());
    let params = KdfParams { m_cost_kib: u32_at(5), t_cost: u32_at(9), parallelism: u32_at(13) };
    params.validate()?;
    Ok(params)
}

impl Vault {
    /// Creates a new vault. Returns the unlocked vault and the key blob to store on the server.
    pub fn create(passphrase: &str) -> Result<(Vault, Vec<u8>)> {
        Self::create_with_params(passphrase, KdfParams::DEFAULT)
    }

    pub fn create_with_params(passphrase: &str, params: KdfParams) -> Result<(Vault, Vec<u8>)> {
        let dek = Dek(random()?);
        let blob = wrap_dek(&dek, passphrase, params)?;
        Ok((Vault { dek, params }, blob))
    }

    pub fn unlock(blob: &[u8], passphrase: &str) -> Result<Vault> {
        if passphrase.is_empty() {
            return Err(Error::Argument("empty passphrase"));
        }
        let params = blob_params(blob)?;

        let (header, rest) = blob.split_at(HEADER_LEN);
        let salt = &header[HEADER_LEN - SALT_LEN..];
        let (nonce, wrapped) = rest.split_at(NONCE_LEN);

        let kek = derive_kek(passphrase, salt, params)?;
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek[..]));
        let plain = cipher
            .decrypt(XNonce::from_slice(nonce), Payload { msg: wrapped, aad: header })
            .map_err(|_| Error::Unlock)?;
        let plain = Zeroizing::new(plain);
        let dek: [u8; 32] = plain[..].try_into().map_err(|_| Error::Format("bad DEK length"))?;
        Ok(Vault { dek: Dek(dek), params })
    }

    /// The raw data-encryption key, to keep a vault unlocked across page reloads.
    /// Whoever holds it can read the whole vault: keep it encrypted at rest (the web app
    /// wraps it with a non-extractable WebCrypto key) and never send it anywhere.
    pub fn export_dek(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.dek.0)
    }

    /// Restores a vault from `export_dek` output. The key blob supplies the KDF
    /// parameters that `rewrap` reuses.
    pub fn from_exported_dek(dek: &[u8], blob: &[u8]) -> Result<Vault> {
        let params = blob_params(blob)?;
        let dek: [u8; 32] = dek.try_into().map_err(|_| Error::Argument("DEK must be 32 bytes"))?;
        Ok(Vault { dek: Dek(dek), params })
    }

    /// Wraps the same DEK under a new passphrase (new salt and nonce). Existing files stay valid.
    /// Never weaker than the default KDF parameters, whatever blob the vault came from.
    pub fn rewrap(&self, new_passphrase: &str) -> Result<Vec<u8>> {
        wrap_dek(&self.dek, new_passphrase, self.params.at_least_default())
    }

    /// Wraps the DEK under a recovery key; store the blob next to the key blob. Anyone with
    /// the words and this blob can open the drive, so it is dropped when the drive changes hands.
    pub fn wrap_for_recovery(&self, key: &RecoveryKey) -> Result<Vec<u8>> {
        let nonce: [u8; NONCE_LEN] = random()?;
        let mut out = Vec::with_capacity(RECOVERY_BLOB_LEN);
        out.extend_from_slice(RECOVERY_MAGIC);
        out.push(RECOVERY_VERSION);
        let kek = key.kek();
        let ct = XChaCha20Poly1305::new(Key::from_slice(&kek[..]))
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: &self.dek.0, aad: &out })
            .map_err(|_| Error::Auth)?;
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        debug_assert_eq!(out.len(), RECOVERY_BLOB_LEN);
        Ok(out)
    }

    /// Opens a vault with its recovery key. `key_blob` (the current passphrase blob)
    /// supplies the KDF parameters that the new passphrase is wrapped with.
    pub fn recover(recovery_blob: &[u8], key: &RecoveryKey, key_blob: &[u8]) -> Result<Vault> {
        let params = blob_params(key_blob)?;
        if recovery_blob.len() != RECOVERY_BLOB_LEN || &recovery_blob[..4] != RECOVERY_MAGIC {
            return Err(Error::Format("bad recovery blob"));
        }
        if recovery_blob[4] != RECOVERY_VERSION {
            return Err(Error::Format("unsupported recovery blob version"));
        }
        let (header, rest) = recovery_blob.split_at(RECOVERY_HEADER_LEN);
        let (nonce, wrapped) = rest.split_at(NONCE_LEN);
        let kek = key.kek();
        let plain = XChaCha20Poly1305::new(Key::from_slice(&kek[..]))
            .decrypt(XNonce::from_slice(nonce), Payload { msg: wrapped, aad: header })
            .map_err(|_| Error::Unlock)?;
        let plain = Zeroizing::new(plain);
        let dek: [u8; 32] = plain[..].try_into().map_err(|_| Error::Format("bad DEK length"))?;
        Ok(Vault { dek: Dek(dek), params })
    }

    /// Per-file key, derived from the DEK and the file's public random salt.
    /// Safe to hand out for sharing: it does not reveal the DEK or other files' keys.
    pub fn file_key(&self, file_salt: &[u8; 16]) -> FileKey {
        FileKey::from_bytes(*self.hkdf(Some(file_salt), b"etherdisk/file/v1"))
    }

    /// Encrypts a small blob (file names, MIME types, folder tree, ...).
    /// `aad` should bind the blob to its context (e.g. vault id + object id)
    /// so the server cannot swap manifests between objects.
    pub fn seal_metadata(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let key = self.hkdf(None, b"etherdisk/metadata/v1");
        let nonce: [u8; NONCE_LEN] = random()?;
        let ct = XChaCha20Poly1305::new(Key::from_slice(&key[..]))
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
            .map_err(|_| Error::Auth)?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn open_metadata(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() < NONCE_LEN + 16 {
            return Err(Error::Format("sealed data too short"));
        }
        let key = self.hkdf(None, b"etherdisk/metadata/v1");
        let (nonce, ct) = sealed.split_at(NONCE_LEN);
        XChaCha20Poly1305::new(Key::from_slice(&key[..]))
            .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
            .map_err(|_| Error::Auth)
    }

    fn hkdf(&self, salt: Option<&[u8]>, info: &[u8]) -> Zeroizing<[u8; 32]> {
        let mut out = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(salt, &self.dek.0).expand(info, &mut *out).expect("32 bytes is a valid HKDF length");
        out
    }
}

fn wrap_dek(dek: &Dek, passphrase: &str, params: KdfParams) -> Result<Vec<u8>> {
    if passphrase.is_empty() {
        return Err(Error::Argument("empty passphrase"));
    }
    params.validate()?;
    let salt: [u8; SALT_LEN] = random()?;
    let nonce: [u8; NONCE_LEN] = random()?;

    let mut out = Vec::with_capacity(KEY_BLOB_LEN);
    out.extend_from_slice(BLOB_MAGIC);
    out.push(BLOB_VERSION);
    out.extend_from_slice(&params.m_cost_kib.to_le_bytes());
    out.extend_from_slice(&params.t_cost.to_le_bytes());
    out.extend_from_slice(&params.parallelism.to_le_bytes());
    out.extend_from_slice(&salt);
    debug_assert_eq!(out.len(), HEADER_LEN);

    let kek = derive_kek(passphrase, &salt, params)?;
    let ct = XChaCha20Poly1305::new(Key::from_slice(&kek[..]))
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &dek.0, aad: &out })
        .map_err(|_| Error::Auth)?;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    debug_assert_eq!(out.len(), KEY_BLOB_LEN);
    Ok(out)
}

fn derive_kek(passphrase: &str, salt: &[u8], p: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    // NFKC so the same passphrase typed on different OS/keyboards yields the same key.
    let normalized: Zeroizing<String> = Zeroizing::new(passphrase.nfkc().collect());
    let params = Params::new(p.m_cost_kib, p.t_cost, p.parallelism, Some(32)).map_err(|_| Error::Kdf)?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(normalized.as_bytes(), salt, &mut *out)
        .map_err(|_| Error::Kdf)?;
    Ok(out)
}
