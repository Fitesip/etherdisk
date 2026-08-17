//! Client-side encryption for NFT Vault.
//!
//! Key hierarchy:
//! passphrase --Argon2id--> KEK --wraps--> DEK (random, per vault/token)
//! DEK --HKDF(file_salt)--> per-file key  --> chunked XChaCha20-Poly1305
//! DEK --HKDF--> metadata key             --> sealed manifests (names, types, ...)
//!
//! The server stores only the wrapped DEK (`Vault::create` / `rewrap` output) and
//! ciphertext. Changing the passphrase re-wraps the DEK; files are never touched.

mod error;
mod file;
mod keys;

pub use error::{Error, Result};
pub use file::{
    chunk_location, decrypt_file, encrypt_file, encrypted_len, plaintext_len, ChunkLocation, FileDecryptor,
    FileEncryptor, FileHeader, FileKey, DEFAULT_CHUNK_SIZE, HEADER_LEN, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, TAG_LEN,
};
pub use keys::{KdfParams, Vault, KEY_BLOB_LEN};
