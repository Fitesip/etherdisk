use etherdisk_crypto::*;

// Cheap Argon2 settings so tests run fast; the default profile is covered separately.
const FAST: KdfParams = KdfParams { m_cost_kib: 8, t_cost: 1, parallelism: 1 };
const CS: u32 = 16; // tiny chunks exercise multi-chunk paths with small buffers

fn vault(pass: &str) -> (Vault, Vec<u8>) {
    Vault::create_with_params(pass, FAST).unwrap()
}

fn data(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 7 + 3) as u8).collect()
}

fn encrypt(v: &Vault, plain: &[u8]) -> Vec<u8> {
    let h = FileHeader::generate(CS).unwrap();
    let key = v.file_key(&h.file_salt);
    encrypt_file(&key, h, plain).unwrap()
}

fn decrypt(v: &Vault, enc: &[u8]) -> Result<Vec<u8>> {
    let h = FileHeader::parse(enc)?;
    decrypt_file(&v.file_key(&h.file_salt), enc)
}

// ------------------------------------------------------------ vault / passphrase

#[test]
fn unlock_roundtrip() {
    let (v, blob) = vault("correct horse");
    assert_eq!(blob.len(), KEY_BLOB_LEN);
    let v2 = Vault::unlock(&blob, "correct horse").unwrap();
    let salt = [9u8; 16];
    assert_eq!(v.file_key(&salt).as_bytes(), v2.file_key(&salt).as_bytes());
}

#[test]
fn default_params_work() {
    let (_, blob) = Vault::create("pass").unwrap();
    assert!(Vault::unlock(&blob, "pass").is_ok());
}

#[test]
fn wrong_passphrase_fails() {
    let (_, blob) = vault("right");
    assert!(matches!(Vault::unlock(&blob, "wrong"), Err(Error::Unlock)));
}

#[test]
fn tampered_blob_fails() {
    let (_, blob) = vault("pass");
    for i in 0..blob.len() {
        let mut b = blob.clone();
        b[i] ^= 1;
        assert!(Vault::unlock(&b, "pass").is_err(), "byte {i} not authenticated");
    }
}

#[test]
fn empty_passphrase_rejected() {
    assert!(Vault::create_with_params("", FAST).is_err());
    let (_, blob) = vault("x");
    assert!(Vault::unlock(&blob, "").is_err());
}

#[test]
fn hostile_kdf_params_rejected_before_hashing() {
    let (_, mut blob) = vault("pass");
    blob[5..9].copy_from_slice(&u32::MAX.to_le_bytes()); // m_cost = 4 TiB
    assert!(matches!(Vault::unlock(&blob, "pass"), Err(Error::Format(_))));
}

#[test]
fn passphrase_unicode_normalization() {
    let (_, blob) = vault("caf\u{e9}"); // precomposed é
    assert!(Vault::unlock(&blob, "cafe\u{301}").is_ok()); // e + combining accent
}

// ------------------------------------------------------------ token transfer scenario

#[test]
fn passphrase_change_keeps_all_files_readable() {
    let (seller, blob) = vault("seller phrase");
    let plain = data(100);
    let enc = encrypt(&seller, &plain);
    let sealed = seller.seal_metadata(b"{\"name\":\"a.png\"}", b"vault1/file1").unwrap();

    // New owner receives the passphrase, unlocks, and changes it.
    let buyer = Vault::unlock(&blob, "seller phrase").unwrap();
    let new_blob = buyer.rewrap("buyer phrase").unwrap();
    assert_ne!(new_blob, blob);

    // Old phrase no longer opens the new blob; the new one opens everything old.
    assert!(Vault::unlock(&new_blob, "seller phrase").is_err());
    let buyer2 = Vault::unlock(&new_blob, "buyer phrase").unwrap();
    assert_eq!(decrypt(&buyer2, &enc).unwrap(), plain);
    assert_eq!(buyer2.open_metadata(&sealed, b"vault1/file1").unwrap(), b"{\"name\":\"a.png\"}");
}

#[test]
fn exported_key_restores_vault() {
    let (v, blob) = vault("pass");
    let enc = encrypt(&v, b"kept across reloads");
    let restored = Vault::from_exported_dek(&v.export_dek()[..], &blob).unwrap();
    assert_eq!(decrypt(&restored, &enc).unwrap(), b"kept across reloads");
    // Rewrap reuses the blob's KDF params; the new blob unlocks the same vault.
    let blob2 = restored.rewrap("new").unwrap();
    assert_eq!(decrypt(&Vault::unlock(&blob2, "new").unwrap(), &enc).unwrap(), b"kept across reloads");

    assert!(Vault::from_exported_dek(&[0u8; 31], &blob).is_err());
    assert!(Vault::from_exported_dek(&v.export_dek()[..], &blob[..10]).is_err());
    let (other, _) = vault("pass");
    assert!(decrypt(&Vault::from_exported_dek(&other.export_dek()[..], &blob).unwrap(), &enc).is_err());
}

#[test]
fn resumed_encryption_matches_uninterrupted() {
    use etherdisk_crypto::{FileEncryptor, FileHeader};
    let (v, _) = vault("p");
    let plain = data(5 * 64 + 10);
    let header = FileHeader::generate(64).unwrap();
    let key = v.file_key(&header.file_salt);

    let whole = encrypt_file(&key, header.clone(), &plain).unwrap();

    // First attempt: header + 2 chunks, then "the tab is reloaded".
    let mut first = FileEncryptor::new(&key, header.clone());
    let mut out = first.header_bytes().to_vec();
    for c in plain.chunks(64).take(2) {
        out.extend(first.encrypt_chunk(c, false).unwrap());
    }
    // Resume at chunk 2 with the same header.
    let mut rest = FileEncryptor::resume(&key, FileHeader::parse(&out[..HEADER_LEN]).unwrap(), 2);
    let tail: Vec<&[u8]> = plain.chunks(64).skip(2).collect();
    for (i, c) in tail.iter().enumerate() {
        out.extend(rest.encrypt_chunk(c, i == tail.len() - 1).unwrap());
    }
    assert_eq!(out, whole);
    assert_eq!(decrypt_file(&key, &out).unwrap(), plain);
}

#[test]
fn inbox_seal_and_open() {
    use etherdisk_crypto::inbox::{seal, InboxSecret, SEALED_OVERHEAD};
    let sig = [7u8; 65];
    let bob = InboxSecret::from_signature(&sig).unwrap();
    // Same signature, same key (the recipient re-derives it later).
    assert_eq!(InboxSecret::from_signature(&sig).unwrap().public(), bob.public());

    let (v, blob) = vault("p");
    let dek = v.export_dek();
    let sealed = seal(&bob.public(), &dek[..], b"handover/1").unwrap();
    assert_eq!(sealed.len(), SEALED_OVERHEAD + 32);
    let opened = bob.open(&sealed, b"handover/1").unwrap();
    let restored = Vault::from_exported_dek(&opened, &blob).unwrap();
    let enc = encrypt(&v, b"for bob");
    assert_eq!(decrypt(&restored, &enc).unwrap(), b"for bob");

    // Other inbox, other token (AAD), tampering: all fail.
    let eve = InboxSecret::from_signature(&[8u8; 65]).unwrap();
    assert!(eve.open(&sealed, b"handover/1").is_err());
    assert!(bob.open(&sealed, b"handover/2").is_err());
    let mut bad = sealed.clone();
    bad[40] ^= 1;
    assert!(bob.open(&bad, b"handover/1").is_err());
    // Low-order public key is refused, and short inputs are rejected.
    assert!(seal(&[0u8; 32], b"x", b"").is_err());
    assert!(InboxSecret::from_signature(&[1u8; 10]).is_err());
    assert!(bob.open(&sealed[..20], b"handover/1").is_err());
}

#[test]
fn reset_creates_independent_vault() {
    let (old, _) = vault("lost");
    let enc = encrypt(&old, b"secret");
    let (fresh, _) = vault("new");
    assert_eq!(decrypt(&fresh, &enc), Err(Error::Auth));
}

// ------------------------------------------------------------ files

#[test]
fn roundtrip_various_sizes() {
    let (v, _) = vault("p");
    for n in [0, 1, 15, 16, 17, 31, 32, 33, 48, 100, 1000] {
        let plain = data(n);
        let enc = encrypt(&v, &plain);
        assert_eq!(enc.len() as u64, encrypted_len(n as u64, CS), "len for {n}");
        assert_eq!(plaintext_len(enc.len() as u64, CS).unwrap(), n as u64);
        assert_eq!(decrypt(&v, &enc).unwrap(), plain, "size {n}");
    }
}

#[test]
fn same_plaintext_encrypts_differently() {
    let (v, _) = vault("p");
    assert_ne!(encrypt(&v, b"hello hello hello"), encrypt(&v, b"hello hello hello"));
}

#[test]
fn wrong_key_fails() {
    let (a, _) = vault("a");
    let (b, _) = vault("b");
    assert_eq!(decrypt(&b, &encrypt(&a, &data(50))), Err(Error::Auth));
}

#[test]
fn any_bit_flip_detected() {
    let (v, _) = vault("p");
    let enc = encrypt(&v, &data(40));
    for i in 0..enc.len() {
        let mut bad = enc.clone();
        bad[i] ^= 0x80;
        assert!(decrypt(&v, &bad).is_err(), "flip at byte {i} went unnoticed");
    }
}

#[test]
fn truncation_at_chunk_boundary_detected() {
    let (v, _) = vault("p");
    let enc = encrypt(&v, &data(64)); // 4 full chunks
    let stride = CS as usize + TAG_LEN;
    let cut = &enc[..HEADER_LEN + 2 * stride];
    assert_eq!(decrypt(&v, cut), Err(Error::Auth));
}

#[test]
fn appended_or_partial_data_detected() {
    let (v, _) = vault("p");
    let mut enc = encrypt(&v, &data(40));
    enc.push(0);
    assert!(decrypt(&v, &enc).is_err());
    enc.truncate(enc.len() - 5);
    assert!(decrypt(&v, &enc).is_err());
}

#[test]
fn chunk_reordering_detected() {
    let (v, _) = vault("p");
    let mut enc = encrypt(&v, &data(48)); // 3 full chunks
    let stride = CS as usize + TAG_LEN;
    let (c0, c1): (Vec<u8>, Vec<u8>) = (
        enc[HEADER_LEN..HEADER_LEN + stride].to_vec(),
        enc[HEADER_LEN + stride..HEADER_LEN + 2 * stride].to_vec(),
    );
    enc[HEADER_LEN..HEADER_LEN + stride].copy_from_slice(&c1);
    enc[HEADER_LEN + stride..HEADER_LEN + 2 * stride].copy_from_slice(&c0);
    assert_eq!(decrypt(&v, &enc), Err(Error::Auth));
}

#[test]
fn header_chunk_size_tampering_detected() {
    let (v, _) = vault("p");
    let mut enc = encrypt(&v, &data(40));
    enc[5..9].copy_from_slice(&(CS * 2).to_le_bytes());
    assert!(decrypt(&v, &enc).is_err());
}

#[test]
fn random_access_chunk_decrypt() {
    let (v, _) = vault("p");
    let plain = data(100);
    let enc = encrypt(&v, &plain);
    let header = FileHeader::parse(&enc).unwrap();
    let dec = FileDecryptor::new(&v.file_key(&header.file_salt), &enc).unwrap();

    // Jump straight to the middle and to the last chunk, as a video player would.
    for index in [3u64, 6] {
        let loc = chunk_location(index, CS, enc.len() as u64).unwrap();
        let ct = &enc[loc.offset as usize..(loc.offset + loc.len) as usize];
        let got = dec.decrypt_chunk(index, ct, loc.is_last).unwrap();
        let start = index as usize * CS as usize;
        assert_eq!(got, plain[start..(start + CS as usize).min(plain.len())]);
    }
    assert!(chunk_location(7, CS, enc.len() as u64).is_err());
}

#[test]
fn last_flag_cannot_be_lied_about() {
    let (v, _) = vault("p");
    let enc = encrypt(&v, &data(48));
    let header = FileHeader::parse(&enc).unwrap();
    let dec = FileDecryptor::new(&v.file_key(&header.file_salt), &enc).unwrap();
    let loc = chunk_location(0, CS, enc.len() as u64).unwrap();
    let ct = &enc[loc.offset as usize..(loc.offset + loc.len) as usize];
    assert!(dec.decrypt_chunk(0, ct, true).is_err());
}

#[test]
fn share_key_decrypts_without_vault() {
    let (v, _) = vault("p");
    let plain = data(70);
    let enc = encrypt(&v, &plain);
    let header = FileHeader::parse(&enc).unwrap();
    // The recipient only has the 32 bytes from the link fragment.
    let shared = FileKey::from_bytes(*v.file_key(&header.file_salt).as_bytes());
    assert_eq!(decrypt_file(&shared, &enc).unwrap(), plain);
}

#[test]
fn file_keys_are_unique_per_file() {
    let (v, _) = vault("p");
    let (h1, h2) = (FileHeader::generate(CS).unwrap(), FileHeader::generate(CS).unwrap());
    assert_ne!(v.file_key(&h1.file_salt).as_bytes(), v.file_key(&h2.file_salt).as_bytes());
}

#[test]
fn encryptor_enforces_chunk_rules() {
    let (v, _) = vault("p");
    let h = FileHeader::generate(CS).unwrap();
    let mut enc = FileEncryptor::new(&v.file_key(&h.file_salt), h);
    assert!(enc.encrypt_chunk(&data(5), false).is_err()); // short non-final chunk
    assert!(enc.encrypt_chunk(&data(17), true).is_err()); // oversize
    enc.encrypt_chunk(&data(16), false).unwrap();
    assert!(enc.encrypt_chunk(&[], true).is_err()); // empty tail after data is non-canonical
    enc.encrypt_chunk(&data(3), true).unwrap();
    assert!(enc.encrypt_chunk(&data(3), true).is_err()); // already finished
}

#[test]
fn length_math_rejects_impossible_sizes() {
    assert!(plaintext_len(10, CS).is_err());
    assert!(plaintext_len(HEADER_LEN as u64, CS).is_err());
    assert!(plaintext_len(HEADER_LEN as u64 + 5, CS).is_err()); // shorter than a tag
}

#[test]
fn invalid_chunk_sizes_rejected() {
    assert!(FileHeader::generate(MIN_CHUNK_SIZE - 1).is_err());
    assert!(FileHeader::generate(MAX_CHUNK_SIZE + 1).is_err());
    assert!(FileHeader::generate(DEFAULT_CHUNK_SIZE).is_ok());
}

// ------------------------------------------------------------ metadata

#[test]
fn metadata_aad_binding() {
    let (v, _) = vault("p");
    let sealed = v.seal_metadata(b"manifest", b"vault1/obj1").unwrap();
    assert_eq!(v.open_metadata(&sealed, b"vault1/obj1").unwrap(), b"manifest");
    assert_eq!(v.open_metadata(&sealed, b"vault1/obj2"), Err(Error::Auth));
}

#[test]
fn default_chunk_roundtrip_multi_mib() {
    let (v, _) = vault("p");
    let plain = data(2 * 1024 * 1024 + 123);
    let h = FileHeader::generate(DEFAULT_CHUNK_SIZE).unwrap();
    let key = v.file_key(&h.file_salt);
    let enc = encrypt_file(&key, h, &plain).unwrap();
    assert_eq!(enc.len() as u64, encrypted_len(plain.len() as u64, DEFAULT_CHUNK_SIZE));
    assert_eq!(decrypt_file(&key, &enc).unwrap(), plain);
}

// ------------------------------------------------------------ recovery key

// BIP-39 test vector: 32 zero bytes of entropy.
const ZERO_WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

#[test]
fn recovery_key_opens_the_drive_and_sets_a_new_passphrase() {
    let (v, blob) = vault("forgotten");
    let enc = encrypt(&v, &data(100));
    let key = RecoveryKey::generate().unwrap();
    let words = key.to_words();
    assert_eq!(words.split(' ').count(), RECOVERY_WORDS);
    let rblob = v.wrap_for_recovery(&key).unwrap();
    assert_eq!(rblob.len(), RECOVERY_BLOB_LEN);

    // Later, from the written-down words only.
    let typed = RecoveryKey::from_words(&words).unwrap();
    let recovered = Vault::recover(&rblob, &typed, &blob).unwrap();
    assert_eq!(decrypt(&recovered, &enc).unwrap(), data(100));
    let new_blob = recovered.rewrap("brand new").unwrap();
    let reopened = Vault::unlock(&new_blob, "brand new").unwrap();
    assert_eq!(decrypt(&reopened, &enc).unwrap(), data(100));
    // The recovery blob keeps working after the passphrase changed: same DEK.
    assert!(Vault::recover(&rblob, &typed, &new_blob).is_ok());
}

#[test]
fn recovery_words_follow_bip39_and_forgive_formatting() {
    let key = RecoveryKey::from_words(ZERO_WORDS).unwrap();
    assert_eq!(&*key.to_words(), &ZERO_WORDS.split_whitespace().collect::<Vec<_>>().join(" "));
    // Numbering, punctuation, case, line breaks and four-letter prefixes are fine.
    let messy = ZERO_WORDS
        .split_whitespace()
        .enumerate()
        .map(|(i, w)| format!("{}. {}", i + 1, if i % 2 == 0 { w[..4].to_uppercase() } else { w.to_string() }))
        .collect::<Vec<_>>()
        .join(",\n");
    assert_eq!(RecoveryKey::from_words(&messy).unwrap().to_words(), key.to_words());
}

#[test]
fn recovery_words_report_what_is_wrong() {
    let words: Vec<&str> = ZERO_WORDS.split_whitespace().collect();
    let with = |i: usize, w: &str| {
        let mut v = words.clone();
        v[i] = w;
        v.join(" ")
    };
    assert_eq!(RecoveryKey::from_words(&with(4, "notaword")).err(), Some(Error::RecoveryWord(5)));
    assert_eq!(RecoveryKey::from_words(&with(4, "ab")).err(), Some(Error::RecoveryWord(5)), "ambiguous prefix");
    assert_eq!(RecoveryKey::from_words(&with(23, "abandon")).err(), Some(Error::RecoveryChecksum));
    assert!(matches!(RecoveryKey::from_words(&words[..23].join(" ")), Err(Error::Argument(_))));
    assert!(matches!(RecoveryKey::from_words(""), Err(Error::Argument(_))));
}

#[test]
fn recovery_blob_rejects_other_keys_and_tampering() {
    let (v, blob) = vault("pass");
    let key = RecoveryKey::generate().unwrap();
    let rblob = v.wrap_for_recovery(&key).unwrap();
    let other = RecoveryKey::generate().unwrap();
    assert_eq!(Vault::recover(&rblob, &other, &blob).err(), Some(Error::Unlock));
    for i in [0, 4, 10, rblob.len() - 1] {
        let mut bad = rblob.clone();
        bad[i] ^= 1;
        assert!(Vault::recover(&bad, &key, &blob).is_err(), "byte {i}");
    }
    assert!(matches!(Vault::recover(&rblob[1..], &key, &blob), Err(Error::Format(_))));
    // Two wraps of the same DEK differ (fresh nonce).
    assert_ne!(v.wrap_for_recovery(&key).unwrap(), rblob);
}

#[test]
fn a_new_passphrase_is_never_wrapped_weaker_than_the_default() {
    // A hostile server hands out a key blob with tiny Argon2 parameters, e.g. as the
    // "current" blob during recovery: it doesn't need to unlock, only to be parsed.
    let (v, _) = vault("real");
    let key = RecoveryKey::generate().unwrap();
    let rblob = v.wrap_for_recovery(&key).unwrap();
    let (_, weak_blob) = vault("whatever"); // FAST: 8 KiB, 1 pass
    let m_cost = |b: &[u8]| u32::from_le_bytes(b[5..9].try_into().unwrap());
    let t_cost = |b: &[u8]| u32::from_le_bytes(b[9..13].try_into().unwrap());
    assert_eq!(m_cost(&weak_blob), 8);

    let recovered = Vault::recover(&rblob, &key, &weak_blob).unwrap();
    let new_blob = recovered.rewrap("chosen after recovery").unwrap();
    assert!(m_cost(&new_blob) >= KdfParams::DEFAULT.m_cost_kib && t_cost(&new_blob) >= KdfParams::DEFAULT.t_cost);
    assert!(Vault::unlock(&new_blob, "chosen after recovery").is_ok());

    // Same for a key handed over by the previous owner.
    let handed = Vault::from_exported_dek(&v.export_dek()[..], &weak_blob).unwrap();
    assert!(m_cost(&handed.rewrap("mine now").unwrap()) >= KdfParams::DEFAULT.m_cost_kib);
}

// ------------------------------------------------------------ key rotation

fn encrypt_new(v: &Vault, plain: &[u8]) -> Vec<u8> {
    let h = FileHeader::generate(CS).unwrap();
    encrypt_file(&v.file_key(&h.file_salt), h, plain).unwrap()
}

fn decrypt_as(v: &Vault, enc: &[u8], key_id: Option<&[u8]>) -> Result<Vec<u8>> {
    let h = FileHeader::parse(enc)?;
    decrypt_file(&v.file_key_for(&h.file_salt, key_id)?, enc)
}

#[test]
fn a_new_owner_gets_a_key_the_previous_owner_never_had() {
    // The previous owner's drive: a file from before key ids existed, and its metadata.
    let (prev, _) = vault("previous owner");
    let old_file = encrypt_new(&prev, &data(50));
    let old_meta = prev.seal_metadata(b"old.txt", b"obj-1").unwrap();

    // The new owner received the same DEK and rotates.
    let received = Vault::from_exported_dek(&prev.export_dek()[..], &vault("x").1).unwrap();
    let mine = received.rotate().unwrap();
    assert_ne!(mine.key_id(), prev.key_id());
    assert_eq!(mine.older_keys(), 1);
    let new_file = encrypt_new(&mine, &data(70));
    let new_meta = mine.seal_metadata(b"new.txt", b"obj-2").unwrap();

    // The new owner reads both; old files by the first key (no id recorded) or its id.
    assert_eq!(decrypt_as(&mine, &old_file, None).unwrap(), data(50));
    assert_eq!(decrypt_as(&mine, &old_file, Some(&prev.key_id())).unwrap(), data(50));
    assert_eq!(decrypt_as(&mine, &new_file, Some(&mine.key_id())).unwrap(), data(70));
    assert_eq!(mine.open_metadata(&old_meta, b"obj-1").unwrap(), b"old.txt");
    assert_eq!(mine.open_metadata(&new_meta, b"obj-2").unwrap(), b"new.txt");

    // The previous owner, who knows the old key, can't read anything added since.
    assert!(prev.open_metadata(&new_meta, b"obj-2").is_err());
    assert!(decrypt_as(&prev, &new_file, None).is_err());
    assert_eq!(prev.file_key_for(&[0; 16], Some(&mine.key_id())).err(), Some(Error::Format("unknown key id")));
}

#[test]
fn keyring_travels_sealed_under_the_current_key() {
    let (first, _) = vault("a");
    let old_file = encrypt_new(&first, &data(10));
    let second = first.rotate().unwrap();
    let third = second.rotate().unwrap();
    let mid_file = encrypt_new(&second, &data(20));
    let ring = third.seal_keyring().unwrap();

    // Another device: only the current key (from the key blob) and the sealed keyring.
    let (_, blob) = vault("b");
    let mut other = Vault::from_exported_dek(&third.export_dek()[..], &blob).unwrap();
    assert!(decrypt_as(&other, &old_file, None).is_err(), "without the keyring old files are closed");
    other.open_keyring(&ring).unwrap();
    assert_eq!(other.older_keys(), 2);
    assert_eq!(decrypt_as(&other, &old_file, None).unwrap(), data(10), "no id = the drive's first key");
    assert_eq!(decrypt_as(&other, &mid_file, Some(&second.key_id())).unwrap(), data(20));

    // A keyring only opens under the key it was sealed for, and can't be altered.
    let mut wrong = Vault::from_exported_dek(&second.export_dek()[..], &blob).unwrap();
    assert!(wrong.open_keyring(&ring).is_err());
    let mut bad = ring.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert!(other.open_keyring(&bad).is_err());
    // An empty keyring (a drive that never changed hands) is fine too.
    let mut fresh = Vault::from_exported_dek(&first.export_dek()[..], &blob).unwrap();
    fresh.open_keyring(&first.seal_keyring().unwrap()).unwrap();
    assert_eq!(fresh.older_keys(), 0);
}
