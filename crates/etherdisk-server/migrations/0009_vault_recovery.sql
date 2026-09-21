-- The drive key wrapped under the owner's recovery words (24 BIP-39 words, kept by the
-- owner). Opens the drive when the passphrase is lost; useless without the words.
CREATE TABLE vault_recovery (
    token_id   TEXT PRIMARY KEY,
    blob       BLOB NOT NULL,
    created_by TEXT NOT NULL,                  -- lowercase 0x-hex; a transfer drops other holders' keys
    created_at INTEGER NOT NULL
);
