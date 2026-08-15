PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backup_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO backup_meta (key, value, updated_at)
VALUES ('schema_version', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Append-only mutation history. Primary-only leaderboard clears never arrive
-- here, so the last pre-clear state remains recoverable.
CREATE TABLE IF NOT EXISTS backup_events (
  source_outbox_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  subject_player_id TEXT,
  operation TEXT NOT NULL,
  payload_json TEXT,
  occurred_at TEXT NOT NULL,
  backed_up_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_events_entity
ON backup_events(entity_type, entity_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_backup_events_time
ON backup_events(occurred_at DESC);

-- Latest entity snapshot accelerates restore. backup_events remains the raw
-- history. A privacy deletion removes/redacts both via the backup consumer.
CREATE TABLE IF NOT EXISTS backup_entity_snapshots (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  subject_player_id TEXT,
  payload_json TEXT,
  source_outbox_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS backup_privacy_deletions (
  player_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  source_outbox_id TEXT NOT NULL
);
