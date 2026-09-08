//! Recovery key: 24 BIP-39 words (256 random bits) that open a drive when its passphrase
//! is lost. The DEK is wrapped under a key derived from the words' entropy with HKDF; no
//! Argon2 is needed because the entropy is already a full-strength random key. The server
//! stores only the wrapped blob (`Vault::wrap_for_recovery`).

use bip39::{Language, Mnemonic};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::keys::random;
use crate::{Error, Result};

pub const RECOVERY_WORDS: usize = 24;

/// A recovery key. Wiped from memory on drop.
pub struct RecoveryKey(Zeroizing<[u8; 32]>);

impl RecoveryKey {
    pub fn generate() -> Result<Self> {
        Ok(Self(Zeroizing::new(random()?)))
    }

    /// Parses the words as the user typed them: case, punctuation, numbering ("1. word")
    /// and extra spaces are ignored, and a word may be shortened to its first four or more
    /// letters (BIP-39 words are unique by their first four).
    pub fn from_words(input: &str) -> Result<Self> {
        let list = Language::English;
        let mut words: Vec<&'static str> = Vec::with_capacity(RECOVERY_WORDS);
        let lower = Zeroizing::new(input.to_lowercase());
        for token in lower.split(|c: char| !c.is_ascii_alphabetic()).filter(|t| !t.is_empty()) {
            let word = match list.find_word(token) {
                Some(i) => list.word_list()[i as usize],
                None => {
                    let mut matches = list.words_by_prefix_iter(token);
                    match (matches.next(), matches.next()) {
                        (Some(only), None) if token.len() >= 4 => only,
                        _ => return Err(Error::RecoveryWord(words.len() + 1)),
                    }
                }
            };
            words.push(word);
        }
        if words.len() != RECOVERY_WORDS {
            return Err(Error::Argument("a recovery key has 24 words"));
        }
        let phrase = Zeroizing::new(words.join(" "));
        let mnemonic = Mnemonic::parse_in_normalized(list, &phrase).map_err(|_| Error::RecoveryChecksum)?;
        let (entropy, len) = mnemonic.to_entropy_array();
        let entropy = Zeroizing::new(entropy);
        let key: [u8; 32] = entropy[..len].try_into().map_err(|_| Error::Argument("a recovery key has 24 words"))?;
        Ok(Self(Zeroizing::new(key)))
    }

    /// The 24 words, separated by single spaces.
    pub fn to_words(&self) -> Zeroizing<String> {
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &self.0[..]).expect("32 bytes is valid BIP-39 entropy");
        Zeroizing::new(mnemonic.words().collect::<Vec<_>>().join(" "))
    }

    /// Key that wraps the DEK.
    pub(crate) fn kek(&self) -> Zeroizing<[u8; 32]> {
        let mut out = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, &self.0[..])
            .expand(b"etherdisk/recovery/v1", &mut *out)
            .expect("32 bytes is a valid HKDF length");
        out
    }
}
