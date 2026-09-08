//! JS-facing wrapper around `etherdisk-crypto`.
//! Build: `wasm-pack build crates/etherdisk-crypto-wasm --target web --release`

use etherdisk_crypto as vc;
use wasm_bindgen::prelude::*;

fn err(e: vc::Error) -> JsError {
    JsError::new(&e.to_string())
}

fn key32(bytes: &[u8]) -> Result<vc::FileKey, JsError> {
    let arr: [u8; 32] = bytes.try_into().map_err(|_| JsError::new("file key must be 32 bytes"))?;
    Ok(vc::FileKey::from_bytes(arr))
}

/// An unlocked vault. Call `free()` when done so the key is wiped from WASM memory.
#[wasm_bindgen]
pub struct WasmVault {
    inner: vc::Vault,
    key_blob: Vec<u8>,
}

#[wasm_bindgen]
impl WasmVault {
    /// Creates a new vault; read `keyBlob` and store it on the server.
    pub fn create(passphrase: &str) -> Result<WasmVault, JsError> {
        let (inner, key_blob) = vc::Vault::create(passphrase).map_err(err)?;
        Ok(WasmVault { inner, key_blob })
    }

    pub fn unlock(key_blob: &[u8], passphrase: &str) -> Result<WasmVault, JsError> {
        let inner = vc::Vault::unlock(key_blob, passphrase).map_err(err)?;
        Ok(WasmVault { inner, key_blob: key_blob.to_vec() })
    }

    /// Raw key for keeping the vault unlocked across reloads. Must be stored encrypted.
    #[wasm_bindgen(js_name = exportKey)]
    pub fn export_key(&self) -> Vec<u8> {
        self.inner.export_dek().to_vec()
    }

    /// Restores a vault from `exportKey` output and its key blob.
    #[wasm_bindgen(js_name = fromExportedKey)]
    pub fn from_exported_key(key: &[u8], key_blob: &[u8]) -> Result<WasmVault, JsError> {
        let inner = vc::Vault::from_exported_dek(key, key_blob).map_err(err)?;
        Ok(WasmVault { inner, key_blob: key_blob.to_vec() })
    }

    /// The wrapped DEK blob as stored on the server.
    #[wasm_bindgen(getter, js_name = keyBlob)]
    pub fn key_blob(&self) -> Vec<u8> {
        self.key_blob.clone()
    }

    /// Re-wraps the DEK under a new passphrase and returns the new blob to upload.
    /// Files are not touched. Updates `keyBlob`.
    #[wasm_bindgen(js_name = changePassphrase)]
    pub fn change_passphrase(&mut self, new_passphrase: &str) -> Result<Vec<u8>, JsError> {
        let blob = self.inner.rewrap(new_passphrase).map_err(err)?;
        self.key_blob = blob.clone();
        Ok(blob)
    }

    #[wasm_bindgen(js_name = sealMetadata)]
    pub fn seal_metadata(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.seal_metadata(plaintext, aad).map_err(err)
    }

    #[wasm_bindgen(js_name = openMetadata)]
    pub fn open_metadata(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
        self.inner.open_metadata(sealed, aad).map_err(err)
    }

    /// Key of an existing file, from its 44-byte header (e.g. to build a share link).
    #[wasm_bindgen(js_name = fileKey)]
    pub fn file_key(&self, header: &[u8]) -> Result<Vec<u8>, JsError> {
        let parsed = vc::FileHeader::parse(header).map_err(err)?;
        Ok(self.inner.file_key(&parsed.file_salt).as_bytes().to_vec())
    }
}

/// Encrypts one file chunk by chunk. Write `header` first, then each `encryptChunk` result.
#[wasm_bindgen]
pub struct WasmFileEncryptor {
    inner: vc::FileEncryptor,
    key: vc::FileKey,
}

#[wasm_bindgen]
impl WasmFileEncryptor {
    #[wasm_bindgen(constructor)]
    pub fn new(vault: &WasmVault, chunk_size: u32) -> Result<WasmFileEncryptor, JsError> {
        let header = vc::FileHeader::generate(chunk_size).map_err(err)?;
        let key = vault.inner.file_key(&header.file_salt);
        Ok(WasmFileEncryptor { inner: vc::FileEncryptor::new(&key, header), key })
    }

    /// Continues an interrupted upload at chunk `next_index` with the file's original
    /// header. Only feed the same plaintext as before (see `FileEncryptor::resume`).
    pub fn resume(vault: &WasmVault, header: &[u8], next_index: u32) -> Result<WasmFileEncryptor, JsError> {
        let header = vc::FileHeader::parse(header).map_err(err)?;
        let key = vault.inner.file_key(&header.file_salt);
        Ok(WasmFileEncryptor { inner: vc::FileEncryptor::resume(&key, header, next_index.into()), key })
    }

    #[wasm_bindgen(getter)]
    pub fn header(&self) -> Vec<u8> {
        self.inner.header_bytes().to_vec()
    }

    /// The per-file key (32 bytes), e.g. to put into a share link fragment.
    #[wasm_bindgen(getter, js_name = fileKey)]
    pub fn file_key(&self) -> Vec<u8> {
        self.key.as_bytes().to_vec()
    }

    #[wasm_bindgen(js_name = encryptChunk)]
    pub fn encrypt_chunk(&mut self, plaintext: &[u8], is_last: bool) -> Result<Vec<u8>, JsError> {
        self.inner.encrypt_chunk(plaintext, is_last).map_err(err)
    }
}

/// Decrypts chunks of one file, in any order.
#[wasm_bindgen]
pub struct WasmFileDecryptor {
    inner: vc::FileDecryptor,
}

#[wasm_bindgen]
impl WasmFileDecryptor {
    /// Owner path: the key is derived from the vault and the header's salt.
    #[wasm_bindgen(js_name = fromVault)]
    pub fn from_vault(vault: &WasmVault, header: &[u8]) -> Result<WasmFileDecryptor, JsError> {
        let parsed = vc::FileHeader::parse(header).map_err(err)?;
        let key = vault.inner.file_key(&parsed.file_salt);
        Ok(WasmFileDecryptor { inner: vc::FileDecryptor::new(&key, header).map_err(err)? })
    }

    /// Share-link path: the key comes from the link fragment.
    #[wasm_bindgen(js_name = fromKey)]
    pub fn from_key(file_key: &[u8], header: &[u8]) -> Result<WasmFileDecryptor, JsError> {
        Ok(WasmFileDecryptor { inner: vc::FileDecryptor::new(&key32(file_key)?, header).map_err(err)? })
    }

    #[wasm_bindgen(getter, js_name = chunkSize)]
    pub fn chunk_size(&self) -> u32 {
        self.inner.chunk_size()
    }

    #[wasm_bindgen(js_name = decryptChunk)]
    pub fn decrypt_chunk(&self, index: u32, ciphertext: &[u8], is_last: bool) -> Result<Vec<u8>, JsError> {
        self.inner.decrypt_chunk(index as u64, ciphertext, is_last).map_err(err)
    }
}

/// Encrypts a whole buffer under an arbitrary 32-byte key (share-link manifests).
#[wasm_bindgen(js_name = encryptWithKey)]
pub fn encrypt_with_key(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    let header = vc::FileHeader::generate(vc::DEFAULT_CHUNK_SIZE).map_err(err)?;
    vc::encrypt_file(&key32(key)?, header, plaintext).map_err(err)
}

/// Decrypts a whole buffer: `encryptWithKey` output, or a small file such as a thumbnail.
#[wasm_bindgen(js_name = decryptWithKey)]
pub fn decrypt_with_key(key: &[u8], data: &[u8]) -> Result<Vec<u8>, JsError> {
    vc::decrypt_file(&key32(key)?, data).map_err(err)
}

/// Inbox public key derived from a wallet signature over the inbox message.
#[wasm_bindgen(js_name = inboxPublicKey)]
pub fn inbox_public_key(signature: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(vc::inbox::InboxSecret::from_signature(signature).map_err(err)?.public().to_vec())
}

/// Seals data (a drive key) to a recipient's inbox public key.
#[wasm_bindgen(js_name = inboxSeal)]
pub fn inbox_seal(recipient: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    vc::inbox::seal(recipient, plaintext, aad).map_err(err)
}

/// Opens data sealed to the inbox derived from `signature`.
#[wasm_bindgen(js_name = inboxOpen)]
pub fn inbox_open(signature: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsError> {
    vc::inbox::InboxSecret::from_signature(signature).map_err(err)?.open(sealed, aad).map_err(err)
}

#[wasm_bindgen(js_name = defaultChunkSize)]
pub fn default_chunk_size() -> u32 {
    vc::DEFAULT_CHUNK_SIZE
}

#[wasm_bindgen(js_name = headerLen)]
pub fn header_len() -> u32 {
    vc::HEADER_LEN as u32
}

/// Size of the encrypted file for a given plaintext size (BigInt in JS).
#[wasm_bindgen(js_name = encryptedLen)]
pub fn encrypted_len(plain_len: u64, chunk_size: u32) -> u64 {
    vc::encrypted_len(plain_len, chunk_size)
}

#[wasm_bindgen(js_name = plaintextLen)]
pub fn plaintext_len(encrypted_len: u64, chunk_size: u32) -> Result<u64, JsError> {
    vc::plaintext_len(encrypted_len, chunk_size).map_err(err)
}

/// Where chunk `index` sits in the encrypted file: returns [offset, length, isLast(0|1)]
/// as BigInt-safe numbers, for building an HTTP Range request.
#[wasm_bindgen(js_name = chunkLocation)]
pub fn chunk_location(index: u32, chunk_size: u32, encrypted_len: u64) -> Result<Vec<u64>, JsError> {
    let l = vc::chunk_location(index as u64, chunk_size, encrypted_len).map_err(err)?;
    Ok(vec![l.offset, l.len, l.is_last as u64])
}
