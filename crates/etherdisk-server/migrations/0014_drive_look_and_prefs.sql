-- More of a drive's look, plaintext like its name and colors: an icon and a cover pattern
-- (ids from the app's sets; NULL = default).
ALTER TABLE vault_profiles ADD COLUMN icon TEXT;
ALTER TABLE vault_profiles ADD COLUMN cover TEXT;

-- Drive-wide settings sealed with the drive key (e.g. the list of labels): the server
-- stores the bytes and cannot read them. Wiped with the drive's files on format.
CREATE TABLE vault_prefs (
    token_id   TEXT PRIMARY KEY,
    blob       BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);
