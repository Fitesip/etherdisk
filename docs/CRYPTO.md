# Etherdisk cryptography

This document specifies how Etherdisk encrypts drives, files, links and key handovers, what
each party can learn, and the known limitations. It is written for a security reviewer; the
code it describes is in `crates/etherdisk-crypto` (Rust, compiled to WASM for the browser),
`web/src/lib/{meta,share,inbox,kept-keys}.ts`, `web/public/sw.js` and `crates/etherdisk-server`.

All encryption and decryption happens in the browser. The server stores ciphertext and
enforces access control; it never receives a passphrase, a drive key, a file key or
recovery words.

## 1. Parties and trust

| Party | Has | Trusted for |
| --- | --- | --- |
| Drive owner | wallet holding the drive NFT, passphrase, optionally recovery words | everything about their drive |
| Server | SQLite database, ciphertext blobs, sessions | availability and access control (who may download what) — **not** confidentiality |
| Chain (Ethereum) | `Etherdisk` ERC-721: who owns which drive, its capacity | ownership |
| Link recipient | a share link (URL with a key in the fragment) | the shared files only |
| Previous / next owner | see §8 | — |

Goal: a party with full access to the server (database, blobs, logs, TLS-terminated traffic)
learns no file contents, file names, folder names or MIME types, and cannot make a client
accept modified data without detection. Non-goals: hiding sizes, counts, timestamps and the
folder structure (§10); protecting against a compromised browser or a malicious frontend
build (§11).

## 2. Primitives

| Use | Primitive |
| --- | --- |
| Passphrase → key | Argon2id (v0x13), 32-byte output |
| AEAD | XChaCha20-Poly1305 (24-byte nonce, 16-byte tag) |
| KDF | HKDF-SHA256 |
| Key agreement | X25519 |
| Password links | PBKDF2-HMAC-SHA256 (WebCrypto), SHA-256 |
| "Stay unlocked" | AES-256-GCM (WebCrypto, non-extractable key) |
| Randomness | `getrandom` → `crypto.getRandomValues` in the browser |
| Recovery words | BIP-39 English word list, 24 words = 256 bits + 8-bit checksum |

Passphrases are NFKC-normalized before Argon2, so the same passphrase typed on different
systems gives the same key.

## 3. Key hierarchy

```
passphrase ──Argon2id(salt, params)──▶ KEK ──XChaCha20-Poly1305──▶ wrapped DEK  (key blob, on server)
recovery words ──HKDF──▶ recovery KEK ──XChaCha20-Poly1305──▶ wrapped DEK  (recovery blob, on server)

DEK (32 random bytes; the drive's current key)
 ├─ HKDF(salt = file_salt, info "etherdisk/file/v1")      ──▶ file key   (one per file / thumbnail)
 ├─ HKDF(salt = none,      info "etherdisk/metadata/v1")  ──▶ metadata key
 ├─ HKDF(salt = none,      info "etherdisk/key-id/v1")[..8] ──▶ key id (public label)
 └─ HKDF(salt = none,      info "etherdisk/keyring/v1")   ──▶ keyring key: seals the drive's older DEKs
```

A drive gets a new DEK when it changes hands (§8a); older DEKs are kept, sealed under the
current one, to read older files. Changing the passphrase or adding a recovery key only
re-wraps the current DEK. Files are never re-encrypted.

## 4. Key blob (passphrase)

Stored on the server per drive; returned only to the drive's current owner.

```
offset size  field
0      4     magic "NVK1"
4      1     version = 1
5      4     Argon2 m_cost KiB (u32 LE)   default 65536 (64 MiB)
9      4     Argon2 t_cost     (u32 LE)   default 3
13     4     Argon2 lanes      (u32 LE)   default 1 (WASM is single-threaded)
17     16    salt (random)
33     24    nonce (random)
57     48    XChaCha20-Poly1305(KEK, nonce, DEK, aad = bytes 0..33)
total 105 bytes
```

- The header (magic, version, KDF parameters, salt) is the AAD, so the server can't change
  parameters or salt without the unlock failing.
- The client refuses parameters above m = 1 GiB, t = 16, p = 16, so a hostile server can't
  make it allocate unbounded memory.
- A new wrap (changing the passphrase, after recovery, after receiving a handed-over key)
  never uses parameters below the defaults. Parameters are only authenticated once a blob
  unlocks; recovery and handover read them from a blob that doesn't have to unlock, so a
  hostile server could otherwise have the new passphrase wrapped with a trivial Argon2
  cost and brute-force it offline. (Found and fixed during this review.)
- Writes are guarded by an etag: replacing the blob requires the hash of the current one,
  so a stale client can't overwrite a newer passphrase.

## 5. Files

Each file (and each thumbnail) has its own key: `HKDF-SHA256(ikm = DEK, salt = file_salt,
info = "etherdisk/file/v1")`, where `file_salt` is 16 random bytes stored in the file header.
A file key opens that file only; it is what share links carry.

Encrypted file layout (a STREAM construction):

```
header (44 bytes) | chunk_0 | chunk_1 | ... | chunk_n

header: magic "NVF1" | version 1 | chunk_size u32 LE | file_salt (16) | nonce_prefix (19)
chunk_i = XChaCha20-Poly1305(file key,
                             nonce = nonce_prefix ‖ i (u32 BE) ‖ last_flag (1 byte),
                             plaintext chunk_i,
                             aad = header)
```

- Every chunk except the last holds exactly `chunk_size` bytes (default 1 MiB, allowed
  16 B … 64 MiB); the last holds 1..`chunk_size` (an empty file is one empty chunk).
- The chunk index and the last-chunk flag in the nonce detect reordering, truncation and
  extension; the header as AAD detects header tampering. Each chunk decrypts independently,
  which video seeking needs (HTTP Range requests decrypted in the Service Worker).
- At most 2³² chunks per file (4 PiB at 1 MiB chunks).
- An interrupted upload resumes with the original header; the client re-encrypts the last
  accepted chunk and compares it with the server's copy before continuing, so a different
  file can't be appended under the same nonces (`FileEncryptor::resume`).

## 6. Metadata

File and folder metadata (name, MIME type, size, mtime, the file's 44-byte header for share
links, the thumbnail header) is JSON sealed with the metadata key:

```
sealed = nonce (24, random) ‖ XChaCha20-Poly1305(metadata key, nonce, json, aad)
aad    = "etherdisk/object/{object id}"
```

The AAD binds metadata to its object id, so the server can't swap names between objects.
The owner's private record of a share link (link key, name, options) is sealed the same way
with `aad = "etherdisk/share"`.

## 7. Share links

```
https://<site>/s/{share id}#{link key, base64url}        plain link
https://<site>/s/{share id}#{link key, base64url}.p      password link
```

- `link key` is 32 random bytes. The fragment never reaches the server.
- The server stores a **manifest**: JSON with the shared files' ids, names, MIME types,
  sizes, folder paths and their **file keys** (and thumbnail keys), encrypted in the file
  format of §5 under the manifest key.
- Plain link: manifest key = link key.
- Password link: manifest key = `SHA-256(link key ‖ PBKDF2-SHA256(password, salt = link key,
  600 000 iterations, 32 bytes))`. The server never sees the password; guessing it offline
  needs the link key, which the server doesn't have.
- Expiry and "view only" are enforced by the server (and, for view only, by the UI); they
  are not cryptographic.
- A link is a snapshot: files added to a shared folder later are not included.
- All of a drive's links are revoked (deleted on the server) when the drive changes owner.

## 8. Handing a drive to its next owner (inbox)

The DEK can be sent to the next owner without the server learning it.

**Inbox key.** The recipient's wallet signs the fixed message *"Etherdisk: open my inbox …"*.
`seed = SHA-256("etherdisk/inbox/v1" ‖ signature)` is an X25519 secret; signing again later
recomputes it (wallets use deterministic ECDSA, RFC 6979). The public key is published on
the server together with a second wallet signature over *"Etherdisk inbox key … Address:
{address} Key: {hex}"*. Senders verify that signature themselves, so the server can't
substitute its own key.

**Sealing.** `sealed = eph_pub (32) ‖ nonce (24) ‖ XChaCha20-Poly1305(k, nonce, DEK,
aad = "etherdisk/handover/{token id}")` with `k = HKDF-SHA256(ikm = X25519(eph, recipient),
salt = eph_pub ‖ recipient_pub, info = "etherdisk/inbox-seal/v1")`. Low-order points
(non-contributory shared secrets) are rejected. The AAD stops a sealed key from being
replayed for another drive.

**Flows.** In-app transfer: the owner seals the DEK before sending the NFT. Transfer outside
the app: the server's indexer sees the `Transfer` event and records a request; the previous
owner later unlocks with their passphrase and seals the DEK. The new owner opens it with the
inbox signature and immediately sets their own passphrase (the DEK is re-wrapped; see §12,
limitation A). A transfer made in the app with "send the key" unchecked records no request.

## 8a. A new key for a new owner

The previous owner knew the drive's DEK. So when a drive changes hands, its new owner
replaces it before using the drive:

- The server records which wallet made the current DEK (`rotated_by`). If the drive's owner
  is another wallet, the key response says `needs_new_key`, and the app asks the new owner
  for their own passphrase right after unlocking (with the old passphrase, a recovery key or
  a handed-over key) — before showing any files.
- The client makes a fresh random DEK, appends the old one to the drive's list of older
  keys, wraps the new DEK with the new passphrase and stores it with the **keyring**:

```
keyring = nonce (24) ‖ XChaCha20-Poly1305(HKDF(DEK, "etherdisk/keyring/v1"), nonce,
                                          older DEK_0 ‖ older DEK_1 ‖ …   (oldest first),
                                          aad = "etherdisk/keyring/v1" ‖ key id of DEK)
```

  The AAD binds the keyring to the current key, so it can't be swapped with another drive's
  or an older generation's. The server replaces key blob and keyring in one step, guarded by
  the etag, and drops recovery blobs (they wrapped the old DEK).
- New files and new metadata use the new DEK. Each file's metadata records the **key id**
  (8 bytes, hex) of the DEK its content and thumbnail use; files from before key ids have
  none and use the drive's first DEK. Metadata is opened by trying the current DEK, then the
  older ones (newest first).
- The previous owner, who knows only the old DEK, can't read anything added since, even with
  the ciphertext. Files that came with the drive stay under the old DEK — they had them anyway.

## 9. Recovery key

24 BIP-39 words = 32 random bytes of entropy (+ checksum).

```
recovery KEK  = HKDF-SHA256(ikm = entropy, salt = none, info = "etherdisk/recovery/v1")
recovery blob = "EDR1" ‖ version 1 ‖ nonce (24) ‖ XChaCha20-Poly1305(recovery KEK, nonce, DEK, aad = bytes 0..5)
                77 bytes, stored on the server per drive, tagged with the wallet that created it
```

No Argon2: the entropy is already a full-strength random key. The blob is returned only to
the drive's current owner, so recovery needs both the words and the owner's wallet. Using
it: open the DEK, choose a new passphrase (new key blob); the recovery blob stays valid
because the DEK is unchanged. Recovery blobs of previous holders are deleted when the drive
changes hands. The UI asks back three random words before saving, and keeps unsaved words
in page memory only.

## 10. What the server sees

- Per drive: the key blob, the recovery blob, name and colors (plaintext, chosen by the
  owner and shown while locked).
- Per object: id, parent folder id, kind (file / folder), ciphertext size, timestamps,
  trash state; ciphertext and thumbnail ciphertext; sealed metadata.
- Per link: which drive, when, expiry, the encrypted manifest (its size hints at how many
  files are shared).
- Per wallet: sessions (hashed bearer tokens), the inbox public key and its signature,
  ideas and signed votes.
- Request metadata: IP addresses, times, which ciphertext ranges were read.

So the server learns the drive's shape (how many files, how big, in which folders, when
they change) but no names, types or contents.

## 11. Browser-side assumptions

- The page's JavaScript is trusted: a malicious frontend build or an XSS can read keys from
  memory. Mitigations: a CSP that only lets the page connect to the API, RPC and
  WalletConnect origins; decrypted files served from the Service Worker in a `sandbox`
  CSP and only for passive media types. `script-src` still has `'unsafe-inline'`
  (Next.js partial prerendering streams inline scripts).
- Session tokens (SIWE, 7 days) live in `localStorage`.
- "Stay unlocked after reload" (off by default): the DEK is encrypted with a
  non-extractable AES-GCM key kept in IndexedDB; the ciphertext lives in this tab's
  `sessionStorage`. Neither store alone reveals the DEK, but script running in the tab can
  still use the AES key.
- Argon2 runs in a Web Worker; keys move to the page as transferable buffers and are
  zeroed after use where the code controls them (`Zeroize` in Rust, `fill(0)` in JS).

## 12. Known limitations and open questions

**A. Files that came with a drive stay under the old key.** Since §8a, what a new owner adds
is out of the previous owner's reach; the files that were on the drive when it changed hands
keep their old DEK, which the previous owner knows. With leaked ciphertext they could still
read those (they owned them before). Re-encrypting them in the background would close this.
A new owner who opens the drive but never sets a passphrase (the app doesn't let them in
until they do) uploads nothing under the old key.

**B. Inbox keys depend on deterministic signatures.** Wallets that sign non-deterministically
(some MPC or smart-contract wallets, e.g. a Safe) derive a different inbox key each time, so
they can't receive keys this way. Anyone who gets the user to sign the inbox message (e.g. a
phishing site) learns the inbox secret; they would still need the sealed blobs, which the
server gives only to the drive's owner. The message doesn't name a domain.

**C. Link keys are forever.** A file key in a link opens that ciphertext indefinitely;
revoking a link removes the server's copy of the manifest and stops serving the files, but
a recipient who saved the ciphertext and the key keeps access to that version.

**D. Server-side rollback.** The server can't forge data, but it can serve an older key blob
(an old passphrase works again), withhold or delete files, or serve an older version of a
file's metadata. Clients don't detect rollback.

**E. Owner share records** are sealed with a constant AAD (`etherdisk/share`), not bound to
the link id, so the server could swap two link records of the same drive in the owner's
list (wrong name next to a link). It can't read or forge them.

Open questions for the reviewer:
1. Are the default Argon2 parameters (64 MiB, 3 passes, 1 lane — WASM has no threads)
   adequate for passphrases that must satisfy the app's rules (8+ characters, upper, lower,
   digit, special)?
2. Is SHA-256(signature ‖ label) an adequate way to derive an X25519 secret from an ECDSA
   signature, and should the signed message bind the site's domain?
3. Is the STREAM construction with a 19-byte random prefix and 2³² chunk counter sound for
   resumed uploads as implemented?
4. Anything else in the format identifiers (`NVK1`, `NVF1`, `EDR1`) or AADs worth changing
   before mainnet, while there is no data to migrate?

## 13. Where to look

| Topic | Code |
| --- | --- |
| Key blob, DEK, file / metadata keys, recovery wrap | `crates/etherdisk-crypto/src/keys.rs` |
| File format | `crates/etherdisk-crypto/src/file.rs` |
| Inbox sealing | `crates/etherdisk-crypto/src/inbox.rs` |
| Recovery words | `crates/etherdisk-crypto/src/recovery.rs` |
| Tests (incl. tampering, BIP-39 vectors) | `crates/etherdisk-crypto/tests/crypto.rs` |
| Metadata AAD | `web/src/lib/meta.ts` |
| Share links, password links | `web/src/lib/share.ts` |
| Inbox messages and handover | `web/src/lib/inbox.ts`, `crates/etherdisk-server/src/handover.rs` |
| Stay unlocked | `web/src/lib/kept-keys.ts` |
| Streaming decryption | `web/public/sw.js` |
| Access control | `crates/etherdisk-server/src/{vaults,objects,shares}.rs` |
