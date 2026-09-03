-- Ideas board: drive owners propose ideas and vote for them (one vote per NFT).
CREATE TABLE ideas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    author     TEXT NOT NULL,                  -- lowercase 0x-hex
    status     TEXT NOT NULL CHECK (status IN ('open', 'planned', 'in_progress', 'done', 'declined')),
    hidden     INTEGER NOT NULL DEFAULT 0,     -- hidden by the admin (spam)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- One row per (idea, token): the vote travels with the NFT; its current holder decides.
-- The signed message is kept so anyone can audit the tally.
CREATE TABLE idea_votes (
    idea_id    INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    token_id   TEXT NOT NULL,
    voter      TEXT NOT NULL,
    message    TEXT NOT NULL,
    signature  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (idea_id, token_id)
);
CREATE INDEX idea_votes_by_token ON idea_votes (token_id);
