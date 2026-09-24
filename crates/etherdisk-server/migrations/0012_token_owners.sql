-- Who holds each drive, from Transfer events (the contract has no per-owner enumeration).
-- A list of a wallet's drives starts here; every entry is checked with ownerOf before use.
CREATE TABLE token_owners (
    token_id TEXT PRIMARY KEY,
    owner    TEXT NOT NULL                     -- lowercase 0x-hex
);
CREATE INDEX token_owners_by_owner ON token_owners (owner);
-- 1 once token_owners holds every transfer the indexer has passed (a database from before
-- this table is filled from past events once, at startup).
ALTER TABLE indexer_state ADD COLUMN owners_synced INTEGER NOT NULL DEFAULT 0;
