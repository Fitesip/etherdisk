-- Drives their owners put up for sale: whether the drive's key goes to the buyer (so its
-- files can be opened) or not. Dropped on any transfer of the token.
CREATE TABLE sales (
    token_id TEXT PRIMARY KEY NOT NULL,
    -- The owner who listed it ('0x…', lowercase); a listing by anyone else is stale.
    owner TEXT NOT NULL,
    with_key INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
