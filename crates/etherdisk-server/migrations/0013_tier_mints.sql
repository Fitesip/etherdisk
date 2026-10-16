-- The tier each drive was minted in, from DriveMinted events: the app marks the tier bought
-- most often as "Popular".
CREATE TABLE tier_mints (
    token_id TEXT PRIMARY KEY,
    tier_id  INTEGER NOT NULL
);
CREATE INDEX tier_mints_by_tier ON tier_mints (tier_id);
-- 1 once tier_mints holds every mint the indexer has passed (an older database is filled
-- from past events once, at startup).
ALTER TABLE indexer_state ADD COLUMN mints_synced INTEGER NOT NULL DEFAULT 0;
