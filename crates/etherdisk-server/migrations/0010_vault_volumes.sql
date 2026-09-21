-- Which storage volume (directory, e.g. one RAID array) holds each vault's files.
-- Volume ids come from the marker file in each directory.
CREATE TABLE vault_volumes (
    token_id   TEXT PRIMARY KEY,
    volume     TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX vault_volumes_by_volume ON vault_volumes (volume);
