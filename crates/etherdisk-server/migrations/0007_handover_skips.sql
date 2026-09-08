-- The owner chose, in the app, to transfer a drive without its key: the indexer then
-- doesn't ask them for it. Matched against the next transfer of the token and removed.
CREATE TABLE handover_skips (
    token_id   TEXT PRIMARY KEY,
    from_addr  TEXT NOT NULL,
    to_addr    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
