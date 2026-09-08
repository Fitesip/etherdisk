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
    /// Recovery words: the word at this position (1-based) is not in the word list.
    #[error("recovery word {0} is not in the word list")]
    RecoveryWord(usize),
    /// Recovery words: every word is valid but they don't add up (a word is wrong or out of order).
    #[error("these recovery words don't match: check each word and their order")]
    RecoveryChecksum,
}

pub type Result<T> = core::result::Result<T, Error>;
