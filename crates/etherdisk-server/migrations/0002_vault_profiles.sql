-- Owner-chosen look of a vault (plaintext: shown on the drive list while locked).
-- Kept across transfers and resets, like the token itself; the new owner can change it.
CREATE TABLE vault_profiles (
    token_id   TEXT PRIMARY KEY,
    name       TEXT,                            -- NULL = default "Drive #id"
    stroke     TEXT,                            -- '#rrggbb' or NULL = theme default
    fill       TEXT,
    updated_at INTEGER NOT NULL
);
