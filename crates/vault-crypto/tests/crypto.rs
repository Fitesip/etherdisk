use vault_crypto::*;

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
