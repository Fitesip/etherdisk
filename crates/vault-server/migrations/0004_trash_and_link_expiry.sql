-- Trash: deleting a file or folder sets trashed_at; it is purged after 30 days or on
-- "delete forever". Everything inside a trashed folder is hidden with it.
ALTER TABLE objects ADD COLUMN trashed_at INTEGER;
CREATE INDEX objects_trashed ON objects (token_id, trashed_at) WHERE trashed_at IS NOT NULL;

-- Optional link expiry (unix seconds); expired links behave as revoked.
ALTER TABLE shares ADD COLUMN expires_at INTEGER;
