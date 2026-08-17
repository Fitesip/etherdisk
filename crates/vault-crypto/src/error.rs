#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    /// Wrong passphrase, or the stored key blob was modified.
    #[error("wrong passphrase or corrupted key blob")]
    Unlock,
    #[error("invalid format: {0}")]
    Format(&'static str),
    /// Ciphertext failed authentication: wrong key, corrupted, truncated or reordered data.
    #[error("authentication failed")]
    Auth,
    #[error("invalid argument: {0}")]
    Argument(&'static str),
    #[error("key derivation failed")]
    Kdf,
    #[error("random number generator failed")]
    Rng,
}

pub type Result<T> = core::result::Result<T, Error>;
