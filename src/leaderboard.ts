import { backupOutboxStatement } from './backup';
import { newId, requestGeography, safeInteger, safeIsoUtc, safeOptionalInteger, utcNow } from './http';
import type { Env, LeaderboardRow, PlatformMeta, PlayerAuth } from './types';

const ORDER_SQL = `
  CASE WHEN l.manual_rank IS NULL THEN 1 ELSE 0 END ASC,
  l.manual_rank ASC,
  l.best_score DESC,
  l.achieved_at ASC,
  l.player_id ASC`;

export async function getLeaderboard(
  env: Env,
  limit = 20,
  offset = 0,
  includeDeleted = false,
): Promise<{ entries: LeaderboardRow[]; total: number }> {
  const where = includeDeleted ? '' : 'WHERE l.deleted_at IS NULL';
  const result = await env.DB.prepare(
    `WITH ranked AS (
       SELECT
         ROW_NUMBER() OVER (ORDER BY ${ORDER_SQL}) AS rank,
         l.player_id,
         p.display_name,
         l.best_score,
         l.level,
         l.achieved_at,
         l.updated_at,
         l.source_platform,
         l.web_source,
         l.device_type,
         l.control_type,
         l.app_version,
         l.verification_status,
         l.manual_rank,
         l.admin_note,
         l.deleted_at
       FROM leaderboard_entries l
       JOIN players p ON p.id = l.player_id
       ${where}
     )
     SELECT * FROM ranked
     ORDER BY rank
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<LeaderboardRow>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM leaderboard_entries l ${where}`,
  ).first<{ total: number }>();
  return { entries: result.results, total: count?.total ?? 0 };
}

export async function getPlayerLeaderboardRow(env: Env, playerId: string): Promise<LeaderboardRow | null> {
  const row = await env.DB.prepare(
    `WITH ranked AS (
       SELECT
         ROW_NUMBER() OVER (ORDER BY ${ORDER_SQL}) AS rank,
         l.player_id,
         p.display_name,
         l.best_score,
         l.level,
         l.achieved_at,
         l.updated_at,
         l.source_platform,
         l.web_source,
         l.device_type,
         l.control_type,
         l.app_version,
         l.verification_status,
         l.manual_rank,
         l.admin_note,
         l.deleted_at
       FROM leaderboard_entries l
       JOIN players p ON p.id = l.player_id
       WHERE l.deleted_at IS NULL
     )
     SELECT * FROM ranked WHERE player_id = ?`,
  ).bind(playerId).first<LeaderboardRow>();
  return row ?? null;
}

export async function submitScore(
  env: Env,
  request: Request,
  auth: PlayerAuth,
  body: Record<string, unknown>,
  meta: PlatformMeta,
): Promise<{ improved: boolean; entry: LeaderboardRow | null; submission_id: string }> {
  const score = safeInteger(body.score, 1, 99_999_999, 'score');
  const level = safeOptionalInteger(body.level, 1, 10_000, 'level');
  const submittedAt = safeIsoUtc(body.occurred_at, 'occurred_at');
  const submissionId = newId();
  const now = utcNow();
  const geography = requestGeography(request);
  const previous = await env.DB.prepare(
    'SELECT best_score FROM leaderboard_entries WHERE player_id = ? AND deleted_at IS NULL',
  ).bind(auth.player_id).first<{ best_score: number }>();
  const improved = !previous || score > previous.best_score;

  const statements: D1PreparedStatement[] = [];
  if (meta.installation_id) {
    statements.push(env.DB.prepare(
      `INSERT INTO installations
        (id, player_id, source_platform, web_source, device_type, device_model, os_name, os_version,
         app_version, first_seen_at, last_seen_at, country_code, region_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         player_id = COALESCE(installations.player_id, excluded.player_id),
         source_platform = excluded.source_platform,
         web_source = excluded.web_source,
         device_type = excluded.device_type,
         device_model = excluded.device_model,
         os_name = excluded.os_name,
         os_version = excluded.os_version,
         app_version = excluded.app_version,
         last_seen_at = excluded.last_seen_at,
         country_code = excluded.country_code,
         region_code = excluded.region_code`,
    ).bind(
      meta.installation_id, auth.player_id, meta.source_platform, meta.web_source, meta.device_type,
      meta.device_model, meta.os_name, meta.os_version, meta.app_version, now, now,
      geography.country_code, geography.region_code,
    ));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO score_submissions
        (id, player_id, installation_id, score, level, submitted_at, source_platform, web_source,
         device_type, control_type, app_version, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified')`,
    ).bind(
      submissionId, auth.player_id, meta.installation_id ?? null, score, level, submittedAt,
      meta.source_platform, meta.web_source, meta.device_type, meta.control_type, meta.app_version,
    ),
    env.DB.prepare(
      `INSERT INTO leaderboard_entries
        (player_id, best_score, level, achieved_at, updated_at, source_platform, web_source,
         device_type, control_type, app_version, verification_status, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', NULL)
       ON CONFLICT(player_id) DO UPDATE SET
         best_score = excluded.best_score,
         level = excluded.level,
         achieved_at = excluded.achieved_at,
         updated_at = excluded.updated_at,
         source_platform = excluded.source_platform,
         web_source = excluded.web_source,
         device_type = excluded.device_type,
         control_type = excluded.control_type,
         app_version = excluded.app_version,
         verification_status = excluded.verification_status,
         deleted_at = NULL
       WHERE excluded.best_score > leaderboard_entries.best_score`,
    ).bind(
      auth.player_id, score, level, submittedAt, now, meta.source_platform, meta.web_source,
      meta.device_type, meta.control_type, meta.app_version,
    ),
    backupOutboxStatement(env.DB, {
      entity_type: 'score_submission',
      entity_id: submissionId,
      subject_player_id: auth.player_id,
      payload: {
        id: submissionId,
        player_id: auth.player_id,
        display_name: auth.display_name,
        score,
        level,
        submitted_at: submittedAt,
        source_platform: meta.source_platform,
        web_source: meta.web_source,
        device_type: meta.device_type,
        control_type: meta.control_type,
        app_version: meta.app_version,
      },
      occurred_at: now,
    }),
  );
  await env.DB.batch(statements);
  return { improved, entry: await getPlayerLeaderboardRow(env, auth.player_id), submission_id: submissionId };
}
