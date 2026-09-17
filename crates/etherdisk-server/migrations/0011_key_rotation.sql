-- A drive's key is replaced when it changes hands. The older keys travel sealed under the
-- current one (`keyring`); `rotated_by` is the wallet that made the current key: any other
-- owner is asked for their own passphrase and makes a new key. NULL: from before rotation.
ALTER TABLE vault_keys ADD COLUMN keyring BLOB;
ALTER TABLE vault_keys ADD COLUMN rotated_by TEXT;
