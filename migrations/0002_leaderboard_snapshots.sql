PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS primary_leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  trigger_type TEXT NOT NULL,
  source_action_id TEXT,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_primary_snapshots_created
ON primary_leaderboard_snapshots(created_at DESC);

-- No UPDATE or DELETE API exists for either snapshot table. These rows are an
-- immutable application record; database-level recovery remains D1 Time Travel.
CREATE TABLE IF NOT EXISTS primary_leaderboard_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES primary_leaderboard_snapshots(id),
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  best_score INTEGER NOT NULL,
  level INTEGER,
  achieved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  web_source TEXT,
  device_type TEXT NOT NULL,
  control_type TEXT,
  app_version TEXT,
  verification_status TEXT NOT NULL,
  manual_rank INTEGER,
  admin_note TEXT,
  deleted_at TEXT,
  PRIMARY KEY (snapshot_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_entries_snapshot_rank
ON primary_leaderboard_snapshot_entries(snapshot_id, manual_rank, best_score DESC);

CREATE TRIGGER IF NOT EXISTS primary_snapshots_no_update
BEFORE UPDATE ON primary_leaderboard_snapshots BEGIN
  SELECT RAISE(ABORT, 'primary snapshots are immutable');
END;
CREATE TRIGGER IF NOT EXISTS primary_snapshots_no_delete
BEFORE DELETE ON primary_leaderboard_snapshots BEGIN
  SELECT RAISE(ABORT, 'primary snapshots are immutable');
END;
CREATE TRIGGER IF NOT EXISTS primary_snapshot_entries_no_update
BEFORE UPDATE ON primary_leaderboard_snapshot_entries BEGIN
  SELECT RAISE(ABORT, 'primary snapshot entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS primary_snapshot_entries_no_delete
BEFORE DELETE ON primary_leaderboard_snapshot_entries BEGIN
  SELECT RAISE(ABORT, 'primary snapshot entries are immutable');
END;

-- Cross-binding backup restores are validated and copied here before the one
-- atomic primary replacement batch.
CREATE TABLE IF NOT EXISTS leaderboard_exact_restore_staging (
  batch_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  best_score INTEGER NOT NULL,
  level INTEGER,
  achieved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  web_source TEXT,
  device_type TEXT NOT NULL,
  control_type TEXT,
  app_version TEXT,
  verification_status TEXT NOT NULL,
  manual_rank INTEGER,
  admin_note TEXT,
  deleted_at TEXT,
  PRIMARY KEY (batch_id, player_id)
);

UPDATE schema_meta SET value = '2', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'schema_version';
