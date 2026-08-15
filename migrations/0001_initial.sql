PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_meta (key, value, updated_at)
VALUES ('schema_version', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE feature_flags (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

INSERT INTO feature_flags (key, enabled, config_json, updated_at)
VALUES
  ('private_leaderboards', 0, '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('score_verification', 0, '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (
    length(trim(display_name)) BETWEEN 1 AND 10
    AND display_name NOT GLOB '*[^A-Za-z0-9 ]*'
  ),
  normalized_name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  recovery_email_ciphertext TEXT,
  recovery_email_iv TEXT,
  recovery_email_hash TEXT,
  recovery_email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_players_recovery_email_hash
ON players(recovery_email_hash)
WHERE recovery_email_hash IS NOT NULL;

CREATE TABLE player_sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_player_sessions_player ON player_sessions(player_id, expires_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  source_platform TEXT NOT NULL CHECK (source_platform IN ('android', 'ios', 'web')),
  web_source TEXT CHECK (web_source IN ('desktop_web', 'mobile_web', 'pwa', 'embedded', 'unknown')),
  device_type TEXT NOT NULL CHECK (device_type IN ('phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown')),
  device_model TEXT,
  os_name TEXT,
  os_version TEXT,
  app_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  country_code TEXT,
  region_code TEXT,
  referral_code TEXT
);

CREATE INDEX idx_installations_player ON installations(player_id);
CREATE INDEX idx_installations_first_seen ON installations(first_seen_at);

CREATE TABLE score_submissions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  installation_id TEXT REFERENCES installations(id) ON DELETE SET NULL,
  score INTEGER NOT NULL CHECK (score > 0 AND score < 100000000),
  level INTEGER CHECK (level IS NULL OR level >= 1),
  submitted_at TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK (source_platform IN ('android', 'ios', 'web')),
  web_source TEXT CHECK (web_source IN ('desktop_web', 'mobile_web', 'pwa', 'embedded', 'unknown')),
  device_type TEXT NOT NULL CHECK (device_type IN ('phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown')),
  control_type TEXT CHECK (control_type IN ('keyboard', 'touch', 'gamepad', 'mixed', 'unknown')),
  app_version TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (
    verification_status IN ('unverified', 'verified', 'flagged', 'rejected')
  )
);

CREATE INDEX idx_score_submissions_player_time ON score_submissions(player_id, submitted_at DESC);
CREATE INDEX idx_score_submissions_time ON score_submissions(submitted_at DESC);

CREATE TABLE leaderboard_entries (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  best_score INTEGER NOT NULL CHECK (best_score > 0 AND best_score < 100000000),
  level INTEGER CHECK (level IS NULL OR level >= 1),
  achieved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK (source_platform IN ('android', 'ios', 'web')),
  web_source TEXT CHECK (web_source IN ('desktop_web', 'mobile_web', 'pwa', 'embedded', 'unknown')),
  device_type TEXT NOT NULL CHECK (device_type IN ('phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown')),
  control_type TEXT CHECK (control_type IN ('keyboard', 'touch', 'gamepad', 'mixed', 'unknown')),
  app_version TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (
    verification_status IN ('unverified', 'verified', 'flagged', 'rejected')
  ),
  manual_rank INTEGER CHECK (manual_rank IS NULL OR manual_rank >= 1),
  admin_note TEXT,
  deleted_at TEXT
);

CREATE INDEX idx_leaderboard_natural_rank
ON leaderboard_entries(best_score DESC, achieved_at ASC, player_id ASC)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_leaderboard_manual_rank
ON leaderboard_entries(manual_rank)
WHERE manual_rank IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'install', 'app_open', 'session_start', 'session_end',
    'game_start', 'game_end', 'level_start', 'level_end',
    'round_start', 'round_end', 'control_used', 'score_submit',
    'leaderboard_view', 'share', 'referral_open', 'account_login'
  )),
  installation_id TEXT NOT NULL,
  player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  session_id TEXT,
  game_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  level INTEGER CHECK (level IS NULL OR level >= 1),
  round INTEGER CHECK (round IS NULL OR round >= 1),
  score INTEGER CHECK (score IS NULL OR score >= 0),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('started', 'completed', 'won', 'lost', 'quit', 'backgrounded', 'unknown')),
  control_type TEXT CHECK (control_type IS NULL OR control_type IN ('keyboard', 'touch', 'gamepad', 'mixed', 'unknown')),
  source_platform TEXT NOT NULL CHECK (source_platform IN ('android', 'ios', 'web')),
  web_source TEXT CHECK (web_source IS NULL OR web_source IN ('desktop_web', 'mobile_web', 'pwa', 'embedded', 'unknown')),
  device_type TEXT NOT NULL CHECK (device_type IN ('phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown')),
  device_model TEXT,
  os_name TEXT,
  os_version TEXT,
  app_version TEXT,
  country_code TEXT,
  region_code TEXT,
  referral_code TEXT
);

CREATE INDEX idx_analytics_received ON analytics_events(received_at DESC);
CREATE INDEX idx_analytics_event_time ON analytics_events(event_name, occurred_at DESC);
CREATE INDEX idx_analytics_install_time ON analytics_events(installation_id, occurred_at DESC);
CREATE INDEX idx_analytics_player_time ON analytics_events(player_id, occurred_at DESC);

CREATE TABLE referral_codes (
  code TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  campaign TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE INDEX idx_referral_codes_player ON referral_codes(player_id);

CREATE TABLE share_events (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  installation_id TEXT,
  referral_code TEXT NOT NULL REFERENCES referral_codes(code) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('facebook', 'instagram', 'x', 'email', 'telegram', 'whatsapp', 'native', 'copy_link')),
  screen TEXT NOT NULL CHECK (screen IN ('title', 'score', 'leaderboard')),
  score INTEGER CHECK (score IS NULL OR score >= 0),
  created_at TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK (source_platform IN ('android', 'ios', 'web')),
  device_type TEXT NOT NULL CHECK (device_type IN ('phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown'))
);

CREATE INDEX idx_share_events_created ON share_events(created_at DESC);
CREATE INDEX idx_share_events_code ON share_events(referral_code, created_at DESC);

CREATE TABLE referral_opens (
  id TEXT PRIMARY KEY,
  referral_code TEXT NOT NULL REFERENCES referral_codes(code) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  country_code TEXT,
  region_code TEXT,
  destination TEXT NOT NULL CHECK (destination IN ('android', 'ios', 'web'))
);

CREATE INDEX idx_referral_opens_code_time ON referral_opens(referral_code, opened_at DESC);

-- Reserved now so Private Leaderboards can be enabled later without replacing
-- player identity, score, analytics, or referral models.
CREATE TABLE private_leaderboards (
  id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  join_code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE private_leaderboard_members (
  leaderboard_id TEXT NOT NULL REFERENCES private_leaderboards(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (leaderboard_id, player_id)
);

CREATE TABLE private_leaderboard_scores (
  leaderboard_id TEXT NOT NULL REFERENCES private_leaderboards(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  best_score INTEGER NOT NULL CHECK (best_score > 0 AND best_score < 100000000),
  level INTEGER,
  achieved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (leaderboard_id, player_id)
);

CREATE INDEX idx_private_scores_rank
ON private_leaderboard_scores(leaderboard_id, best_score DESC, achieved_at ASC)
WHERE deleted_at IS NULL;

CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT
);

CREATE INDEX idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit_logs(target_type, target_id, created_at DESC);

CREATE TABLE leaderboard_clear_batches (
  id TEXT PRIMARY KEY,
  audit_log_id TEXT NOT NULL REFERENCES admin_audit_logs(id),
  actor TEXT NOT NULL,
  reason TEXT,
  cleared_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  undone_at TEXT,
  undone_by TEXT
);

CREATE TABLE leaderboard_clear_batch_items (
  batch_id TEXT NOT NULL REFERENCES leaderboard_clear_batches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES leaderboard_entries(player_id) ON DELETE CASCADE,
  previous_deleted_at TEXT,
  PRIMARY KEY (batch_id, player_id)
);

CREATE TABLE leaderboard_restore_staging (
  batch_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  best_score INTEGER NOT NULL,
  level INTEGER,
  achieved_at TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  web_source TEXT,
  device_type TEXT NOT NULL,
  control_type TEXT,
  app_version TEXT,
  PRIMARY KEY (batch_id, player_id)
);

CREATE TABLE admin_confirmation_challenges (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE rate_limit_windows (
  identifier_hash TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (identifier_hash, route_key, window_start)
);

CREATE INDEX idx_rate_limit_expiry ON rate_limit_windows(expires_at);

-- Normal mutations enqueue a reconstructable event for the redundant backup.
-- The global-clear operation intentionally does not enqueue anything, leaving
-- the backup untouched as required.
CREATE TABLE backup_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  subject_player_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'privacy_delete')),
  payload_json TEXT,
  occurred_at TEXT NOT NULL,
  dispatched_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX idx_backup_outbox_pending ON backup_outbox(dispatched_at, occurred_at);
