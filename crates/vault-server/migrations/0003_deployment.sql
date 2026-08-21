-- The contract this database belongs to. Token ids (and with them keys, files and
-- links) only mean something for the contract that minted them, so the server refuses
-- to start against a different contract instead of handing token #1's files to a new #1.
CREATE TABLE deployment (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    contract TEXT NOT NULL,                  -- lowercase 0x-hex
    chain_id INTEGER NOT NULL
);
