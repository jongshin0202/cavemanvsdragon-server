ALTER TABLE players ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'legacy_device'
  CHECK (auth_kind IN ('password', 'legacy_device'));

UPDATE players SET auth_kind = 'password'
WHERE EXISTS (
  SELECT 1 FROM referral_codes r
  WHERE r.player_id = players.id AND r.campaign = 'player'
);

CREATE TABLE IF NOT EXISTS profile_device_credentials (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_device_credentials_player
ON profile_device_credentials(player_id, revoked_at);

UPDATE schema_meta
SET value = '4', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'schema_version';
