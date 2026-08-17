//! Chunked file encryption (STREAM-style construction over XChaCha20-Poly1305).
//!
//! Layout of an encrypted file:
//!   header (44 bytes) | chunk_0 | chunk_1 | ... | chunk_n
//! Every chunk except the last holds exactly `chunk_size` plaintext bytes (+16 byte tag).
//! The last chunk holds 1..=chunk_size bytes (an empty file has one empty chunk).
//!
//! Chunk nonce = nonce_prefix(19) | chunk_index(u32 BE) | last_flag(1).
//! The header is authenticated as AAD of every chunk. This detects truncation,
//! reordering, header tampering and bit flips, and allows decrypting any chunk
//! independently (needed for video seeking via HTTP Range requests).

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::keys::random;
use crate::{Error, Result};

pub const HEADER_LEN: usize = 44;
pub const TAG_LEN: usize = 16;
pub const DEFAULT_CHUNK_SIZE: u32 = 1 << 20; // 1 MiB
pub const MIN_CHUNK_SIZE: u32 = 16;
pub const MAX_CHUNK_SIZE: u32 = 64 << 20;

const MAGIC: &[u8; 4] = b"NVF1";
const VERSION: u8 = 1;

/// Symmetric key of a single file. Handing it out grants access to that file only.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct FileKey([u8; 32]);

impl FileKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileHeader {
    pub chunk_size: u32,
    /// Public random salt; the file key is derived from it via `Vault::file_key`.
    pub file_salt: [u8; 16],
    nonce_prefix: [u8; 19],
}

impl FileHeader {
    pub fn generate(chunk_size: u32) -> Result<Self> {
        check_chunk_size(chunk_size)?;
        Ok(Self { chunk_size, file_salt: random()?, nonce_prefix: random()? })
    }

    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[..4].copy_from_slice(MAGIC);
        b[4] = VERSION;
        b[5..9].copy_from_slice(&self.chunk_size.to_le_bytes());
        b[9..25].copy_from_slice(&self.file_salt);
        b[25..44].copy_from_slice(&self.nonce_prefix);
        b
    }

    /// Parses the first `HEADER_LEN` bytes of an encrypted file.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN {
            return Err(Error::Format("header too short"));
        }
        if &bytes[..4] != MAGIC {
            return Err(Error::Format("not an encrypted vault file"));
        }
        if bytes[4] != VERSION {
            return Err(Error::Format("unsupported file version"));
        }
        let chunk_size = u32::from_le_bytes(bytes[5..9].try_into().unwrap());
        check_chunk_size(chunk_size)?;
        Ok(Self {
            chunk_size,
            file_salt: bytes[9..25].try_into().unwrap(),
            nonce_prefix: bytes[25..44].try_into().unwrap(),
        })
    }
}

fn check_chunk_size(chunk_size: u32) -> Result<()> {
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(Error::Argument("chunk size out of range"));
    }
    Ok(())
}

fn chunk_nonce(prefix: &[u8; 19], index: u64, last: bool) -> Result<XNonce> {
    let index = u32::try_from(index).map_err(|_| Error::Argument("chunk index too large"))?;
    let mut n = [0u8; 24];
    n[..19].copy_from_slice(prefix);
    n[19..23].copy_from_slice(&index.to_be_bytes());
    n[23] = last as u8;
    Ok(XNonce::clone_from_slice(&n))
}

/// Sequential encryptor: feed chunks in order, mark the final one with `is_last`.
pub struct FileEncryptor {
    cipher: XChaCha20Poly1305,
    header: FileHeader,
    header_bytes: [u8; HEADER_LEN],
    next_index: u64,
    finished: bool,
}

impl FileEncryptor {
    pub fn new(key: &FileKey, header: FileHeader) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(Key::from_slice(key.as_bytes())),
            header_bytes: header.to_bytes(),
            header,
            next_index: 0,
            finished: false,
        }
    }

    /// Bytes to write at the start of the encrypted file.
    pub fn header_bytes(&self) -> [u8; HEADER_LEN] {
        self.header_bytes
    }

    pub fn chunk_size(&self) -> u32 {
        self.header.chunk_size
    }

    /// Non-final chunks must be exactly `chunk_size` bytes; the final chunk 1..=chunk_size
    /// bytes (it may be empty only if the whole file is empty).
    pub fn encrypt_chunk(&mut self, plaintext: &[u8], is_last: bool) -> Result<Vec<u8>> {
        if self.finished {
            return Err(Error::Argument("encryptor already finished"));
        }
        let cs = self.header.chunk_size as usize;
        if is_last {
            if plaintext.len() > cs || (plaintext.is_empty() && self.next_index > 0) {
                return Err(Error::Argument("invalid final chunk size"));
            }
        } else if plaintext.len() != cs {
            return Err(Error::Argument("non-final chunk must be exactly chunk_size bytes"));
        }
        let nonce = chunk_nonce(&self.header.nonce_prefix, self.next_index, is_last)?;
        let ct = self
            .cipher
            .encrypt(&nonce, Payload { msg: plaintext, aad: &self.header_bytes })
            .map_err(|_| Error::Auth)?;
        self.next_index += 1;
        self.finished = is_last;
        Ok(ct)
    }
}

/// Random-access decryptor: any chunk can be decrypted independently.
pub struct FileDecryptor {
    cipher: XChaCha20Poly1305,
    header: FileHeader,
    header_bytes: [u8; HEADER_LEN],
}

impl FileDecryptor {
    pub fn new(key: &FileKey, header_bytes: &[u8]) -> Result<Self> {
        let header = FileHeader::parse(header_bytes)?;
        Ok(Self {
            cipher: XChaCha20Poly1305::new(Key::from_slice(key.as_bytes())),
            header_bytes: header_bytes[..HEADER_LEN].try_into().unwrap(),
            header,
        })
    }

    pub fn header(&self) -> &FileHeader {
        &self.header
    }

    pub fn chunk_size(&self) -> u32 {
        self.header.chunk_size
    }

    /// `is_last` must come from the file length (see `chunk_location`), never from the server's say-so
    /// about content: a truncated file then fails authentication instead of decrypting silently.
    pub fn decrypt_chunk(&self, index: u64, ciphertext: &[u8], is_last: bool) -> Result<Vec<u8>> {
        let stride = self.header.chunk_size as usize + TAG_LEN;
        if ciphertext.len() < TAG_LEN || ciphertext.len() > stride || (!is_last && ciphertext.len() != stride) {
            return Err(Error::Format("invalid chunk length"));
        }
        let nonce = chunk_nonce(&self.header.nonce_prefix, index, is_last)?;
        self.cipher
            .decrypt(&nonce, Payload { msg: ciphertext, aad: &self.header_bytes })
            .map_err(|_| Error::Auth)
    }
}

// ---------------------------------------------------------------- layout math

/// Total size of the encrypted file for a plaintext of `plain_len` bytes.
pub fn encrypted_len(plain_len: u64, chunk_size: u32) -> u64 {
    let chunks = if plain_len == 0 { 1 } else { plain_len.div_ceil(chunk_size as u64) };
    HEADER_LEN as u64 + plain_len + chunks * TAG_LEN as u64
}

/// Inverse of `encrypted_len`. Fails for lengths no valid encryptor could produce
/// (i.e. truncated or padded files). Also what quota accounting can rely on.
pub fn plaintext_len(encrypted_len: u64, chunk_size: u32) -> Result<u64> {
    let tag = TAG_LEN as u64;
    let body = encrypted_len.checked_sub(HEADER_LEN as u64).ok_or(Error::Format("file too short"))?;
    let stride = chunk_size as u64 + tag;
    let (full, rem) = (body / stride, body % stride);
    let chunks = if rem == 0 {
        if full == 0 {
            return Err(Error::Format("file has no chunks"));
        }
        full
    } else if rem < tag || (rem == tag && full > 0) {
        return Err(Error::Format("invalid encrypted length"));
    } else {
        full + 1
    };
    Ok(body - chunks * tag)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkLocation {
    /// Byte offset of the chunk inside the encrypted file (for an HTTP Range request).
    pub offset: u64,
    pub len: u64,
    pub is_last: bool,
}

/// Where chunk `index` lives in an encrypted file of `encrypted_len` bytes.
pub fn chunk_location(index: u64, chunk_size: u32, encrypted_len: u64) -> Result<ChunkLocation> {
    plaintext_len(encrypted_len, chunk_size)?;
    let stride = chunk_size as u64 + TAG_LEN as u64;
    let offset = HEADER_LEN as u64 + index.checked_mul(stride).ok_or(Error::Argument("chunk index too large"))?;
    if offset >= encrypted_len {
        return Err(Error::Argument("chunk index out of range"));
    }
    let len = stride.min(encrypted_len - offset);
    Ok(ChunkLocation { offset, len, is_last: offset + len == encrypted_len })
}

// ---------------------------------------------------------------- whole-buffer helpers
// For small objects (thumbnails, tests). Large files go through FileEncryptor chunk by chunk.

pub fn encrypt_file(key: &FileKey, header: FileHeader, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut enc = FileEncryptor::new(key, header);
    let mut out = enc.header_bytes().to_vec();
    if plaintext.is_empty() {
        out.extend(enc.encrypt_chunk(&[], true)?);
        return Ok(out);
    }
    let cs = enc.chunk_size() as usize;
    let n = plaintext.chunks(cs).count();
    for (i, chunk) in plaintext.chunks(cs).enumerate() {
        out.extend(enc.encrypt_chunk(chunk, i + 1 == n)?);
    }
    Ok(out)
}

pub fn decrypt_file(key: &FileKey, data: &[u8]) -> Result<Vec<u8>> {
    let dec = FileDecryptor::new(key, data)?;
    let plain_len = plaintext_len(data.len() as u64, dec.chunk_size())?;
    let mut out = Vec::with_capacity(plain_len as usize);
    let stride = dec.chunk_size() as usize + TAG_LEN;
    let body = &data[HEADER_LEN..];
    let n = body.chunks(stride).count();
    for (i, chunk) in body.chunks(stride).enumerate() {
        out.extend(dec.decrypt_chunk(i as u64, chunk, i + 1 == n)?);
    }
    Ok(out)
}
