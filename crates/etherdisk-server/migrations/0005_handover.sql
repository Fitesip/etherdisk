-- Inbox keys: X25519 public keys users publish (with a wallet signature binding the key
-- to their address) so a drive's key can be sealed to them when they receive a drive.
CREATE TABLE inbox_keys (
    address    TEXT PRIMARY KEY,               -- lowercase 0x-hex
    pubkey     BLOB NOT NULL,                  -- 32 bytes
    signature  TEXT NOT NULL,                  -- 0x-hex signature over the inbox message
    created_at INTEGER NOT NULL
);

-- One pending handover per token: the drive key sealed to the new owner's inbox, or a
-- request (sealed IS NULL) for the previous owner to provide it.
CREATE TABLE handovers (
    token_id   TEXT PRIMARY KEY,
    from_addr  TEXT NOT NULL,
    to_addr    TEXT NOT NULL,
    sealed     BLOB,
    key_etag   TEXT,                           -- key blob at transfer time; the previous owner gets the blob only while unchanged
    created_at INTEGER NOT NULL
);
