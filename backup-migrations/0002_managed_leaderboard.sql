PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS managed_leaderboard_state (
  player_id TEXT PRIMARY KEY,
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
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  manual_rank INTEGER,
  admin_note TEXT,
  deleted_at TEXT,
  latest_action_type TEXT NOT NULL,
  latest_action_at TEXT NOT NULL,
  source_action_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_managed_leaderboard_order
ON managed_leaderboard_state(deleted_at, manual_rank, best_score DESC);

CREATE TABLE IF NOT EXISTS backup_confirmation_challenges (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  required_phrase TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS backup_admin_actions (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  confirmation_challenge_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  permanent_no_undo INTEGER NOT NULL DEFAULT 1 CHECK (permanent_no_undo = 1),
  primary_audit_id TEXT,
  primary_audit_synced_at TEXT,
  UNIQUE (confirmation_challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_backup_admin_actions_created
ON backup_admin_actions(created_at DESC);

-- Prefer complete current leaderboard-entry snapshots. Older installations
-- that only contain score_submission payloads are completed at runtime by the
-- documented migration/smoke-test backfill because SQLite JSON availability
-- differs between Wrangler/D1 migration environments.
INSERT OR IGNORE INTO managed_leaderboard_state
 (player_id, display_name, best_score, level, achieved_at, updated_at,
  source_platform, web_source, device_type, control_type, app_version,
  verification_status, manual_rank, admin_note, deleted_at,
  latest_action_type, latest_action_at, source_action_id)
SELECT entity_id,
       COALESCE(json_extract(payload_json, '$.display_name'), 'Recovered'),
       json_extract(payload_json, '$.best_score'), json_extract(payload_json, '$.level'),
       json_extract(payload_json, '$.achieved_at'), json_extract(payload_json, '$.updated_at'),
       json_extract(payload_json, '$.source_platform'), json_extract(payload_json, '$.web_source'),
       json_extract(payload_json, '$.device_type'), json_extract(payload_json, '$.control_type'),
       json_extract(payload_json, '$.app_version'),
       COALESCE(json_extract(payload_json, '$.verification_status'), 'unverified'),
       json_extract(payload_json, '$.manual_rank'), json_extract(payload_json, '$.admin_note'),
       json_extract(payload_json, '$.deleted_at'),
       CASE WHEN operation = 'delete' THEN 'soft_deleted' ELSE 'replicated' END,
       updated_at, source_outbox_id
FROM backup_entity_snapshots
WHERE entity_type = 'leaderboard_entry' AND payload_json IS NOT NULL
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.best_score') = 'integer';

-- Lossy fallback for legacy installations that only retained score submission
-- snapshots. The payload contains the submitting display name, score metadata,
-- and timestamp, but cannot reconstruct admin notes/order/deletion decisions.
INSERT OR IGNORE INTO managed_leaderboard_state
 (player_id, display_name, best_score, level, achieved_at, updated_at,
  source_platform, web_source, device_type, control_type, app_version,
  verification_status, manual_rank, admin_note, deleted_at,
  latest_action_type, latest_action_at, source_action_id)
SELECT player_id, display_name, score, level, submitted_at, source_updated_at,
       source_platform, web_source, device_type, control_type, app_version,
       'unverified', NULL, NULL, NULL, 'legacy_score_fallback',
       source_updated_at, source_outbox_id
FROM (
  SELECT json_extract(payload_json, '$.player_id') AS player_id,
         COALESCE(json_extract(payload_json, '$.display_name'), 'Recovered') AS display_name,
         json_extract(payload_json, '$.score') AS score,
         json_extract(payload_json, '$.level') AS level,
         json_extract(payload_json, '$.submitted_at') AS submitted_at,
         json_extract(payload_json, '$.source_platform') AS source_platform,
         json_extract(payload_json, '$.web_source') AS web_source,
         json_extract(payload_json, '$.device_type') AS device_type,
         json_extract(payload_json, '$.control_type') AS control_type,
         json_extract(payload_json, '$.app_version') AS app_version,
         updated_at AS source_updated_at, source_outbox_id,
         ROW_NUMBER() OVER (
           PARTITION BY json_extract(payload_json, '$.player_id')
           ORDER BY json_extract(payload_json, '$.score') DESC,
                    json_extract(payload_json, '$.submitted_at') ASC,
                    source_outbox_id ASC
         ) AS choice
  FROM backup_entity_snapshots
  WHERE entity_type = 'score_submission' AND operation = 'upsert'
    AND payload_json IS NOT NULL AND json_valid(payload_json)
    AND json_type(payload_json, '$.player_id') = 'text'
    AND json_type(payload_json, '$.score') = 'integer'
    AND json_extract(payload_json, '$.score') BETWEEN 1 AND 99999999
    AND json_type(payload_json, '$.submitted_at') = 'text'
    AND json_extract(payload_json, '$.source_platform') IN ('android','ios','web')
    AND json_extract(payload_json, '$.device_type') IN ('phone','tablet','desktop','tv','handheld','unknown')
) WHERE choice = 1;

UPDATE backup_meta SET value = '2', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'schema_version';
