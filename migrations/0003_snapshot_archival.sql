PRAGMA foreign_keys = ON;

-- Snapshot headers and entries remain immutable. This separate mutable state
-- controls only whether a recovery point appears in the active admin list.
CREATE TABLE IF NOT EXISTS primary_snapshot_archive_state (
  snapshot_id TEXT PRIMARY KEY REFERENCES primary_leaderboard_snapshots(id),
  archived_at TEXT NOT NULL,
  archived_by TEXT NOT NULL,
  archive_reason TEXT,
  unarchived_at TEXT,
  unarchived_by TEXT,
  updated_at TEXT NOT NULL,
  CHECK (unarchived_at IS NULL OR unarchived_at >= archived_at)
);

CREATE INDEX IF NOT EXISTS idx_primary_snapshot_archive_active
ON primary_snapshot_archive_state(unarchived_at, archived_at DESC);

UPDATE schema_meta SET value = '3', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'schema_version';
