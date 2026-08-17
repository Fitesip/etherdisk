-- Token ids are stored as decimal strings (uint256). Addresses as lowercase 0x-hex.
-- Timestamps are unix seconds.

-- Wrapped DEK of a vault (vault-crypto key blob). Absent = vault not initialized yet.
CREATE TABLE vault_keys (
    token_id   TEXT PRIMARY KEY,
    key_blob   BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Files and folders. Names, MIME types etc. live in the encrypted `metadata` blob;
-- the server only sees the tree shape and ciphertext sizes.
CREATE TABLE objects (
    id         TEXT PRIMARY KEY,                -- UUID chosen by the client (it is part of the metadata AAD)
    token_id   TEXT NOT NULL,
    parent_id  TEXT REFERENCES objects(id) ON DELETE CASCADE, -- NULL = vault root
    kind       TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    metadata   BLOB NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,      -- encrypted content size, reserved at upload start
    thumb_size INTEGER,                         -- encrypted thumbnail size, NULL = no thumbnail
    status     TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX objects_by_parent ON objects (token_id, parent_id);

-- Public links. `manifest` is encrypted with a key that lives only in the link fragment;
-- `owner_metadata` is sealed with the vault key so the owner can list and re-copy links.
CREATE TABLE shares (
    id             TEXT PRIMARY KEY,
    token_id       TEXT NOT NULL,
    owner          TEXT NOT NULL,               -- token owner at creation; link dies when it changes
    manifest       BLOB NOT NULL,
    owner_metadata BLOB NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX shares_by_token ON shares (token_id);

-- Files a share grants access to (a folder share lists every file inside it).
CREATE TABLE share_objects (
    share_id  TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    PRIMARY KEY (share_id, object_id)
);
CREATE INDEX share_objects_by_object ON share_objects (object_id);

CREATE TABLE auth_nonces (
    nonce      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash BLOB PRIMARY KEY,                -- sha256 of the bearer token
    address    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Transfer-event indexer progress.
CREATE TABLE indexer_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    next_block INTEGER NOT NULL
);
