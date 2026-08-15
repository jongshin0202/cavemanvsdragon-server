import { backupOutboxStatement } from './backup';
import { newId, readJson, safeIsoUtc, safeOptionalInteger, utcNow } from './http';
import { getLeaderboard } from './leaderboard';
import { HttpError, type AdminAuth, type Env, type LeaderboardRow } from './types';
import { validateDisplayName } from './validation';
import { snapshotStatements } from './leaderboard-admin-safety';

interface AuditRow {
  id: string;
  action: string;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  undone_at: string | null;
}

function auditStatement(
  env: Env,
  input: {
    id: string;
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    createdAt: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_audit_logs
      (id, actor, action, target_type, target_id, before_json, after_json, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.actor,
    input.action,
    input.targetType,
    input.targetId ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.reason ?? null,
    input.createdAt,
  );
}

async function adminLeaderboardRow(env: Env, playerId: string): Promise<LeaderboardRow | null> {
  const row = await env.DB.prepare(
    `SELECT
       0 AS rank,
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
     WHERE l.player_id = ?`,
  ).bind(playerId).first<LeaderboardRow>();
  return row ?? null;
}

function optionalText(value: unknown, max: number, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, 'invalid_field', `${field} is invalid.`, { field });
  }
  return value.trim().slice(0, max) || null;
}

export async function listAdminLeaderboard(
  env: Env,
  url: URL,
): Promise<{ entries: LeaderboardRow[]; total: number }> {
  const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const includeDeleted = url.searchParams.get('include_deleted') === 'true';
  return getLeaderboard(env, limit, offset, includeDeleted);
}

export async function updateLeaderboardEntry(
  request: Request,
  env: Env,
  admin: AdminAuth,
  playerId: string,
): Promise<{ audit_id: string; entry: LeaderboardRow }> {
  const before = await adminLeaderboardRow(env, playerId);
  if (!before) throw new HttpError(404, 'leaderboard_entry_not_found', 'Leaderboard entry was not found.');
  const body = await readJson<Record<string, unknown>>(request);
  const now = utcNow();
  const statements: D1PreparedStatement[] = [];
  let displayName = before.display_name;
  if (body.display_name !== undefined) {
    const validated = validateDisplayName(body.display_name);
    displayName = validated.display_name;
    statements.push(env.DB.prepare(
      'UPDATE players SET display_name = ?, normalized_name = ?, updated_at = ? WHERE id = ?',
    ).bind(validated.display_name, validated.normalized_name, now, playerId));
  }

  const bestScore = body.best_score === undefined
    ? before.best_score
    : safeOptionalInteger(body.best_score, 1, 99_999_999, 'best_score');
  if (bestScore === null) throw new HttpError(400, 'invalid_field', 'best_score cannot be null.');
  const level = body.level === undefined ? before.level : safeOptionalInteger(body.level, 1, 10_000, 'level');
  const achievedAt = body.achieved_at === undefined
    ? before.achieved_at
    : safeIsoUtc(body.achieved_at, 'achieved_at');
  const manualRank = body.manual_rank === undefined
    ? before.manual_rank
    : safeOptionalInteger(body.manual_rank, 1, 1_000_000, 'manual_rank');
  const adminNote = optionalText(body.admin_note, 500, 'admin_note');
  const verification = body.verification_status === undefined
    ? before.verification_status
    : optionalText(body.verification_status, 20, 'verification_status');
  if (verification && !['unverified', 'verified', 'flagged', 'rejected'].includes(verification)) {
    throw new HttpError(400, 'invalid_field', 'verification_status is invalid.');
  }
  const after: LeaderboardRow = {
    ...before,
    display_name: displayName,
    best_score: bestScore,
    level,
    achieved_at: achievedAt,
    updated_at: now,
    manual_rank: manualRank,
    admin_note: adminNote === undefined ? before.admin_note : adminNote,
    verification_status: verification ?? before.verification_status,
  };
  statements.push(env.DB.prepare(
    `UPDATE leaderboard_entries SET
       best_score = ?, level = ?, achieved_at = ?, updated_at = ?, manual_rank = ?,
       admin_note = ?, verification_status = ?
     WHERE player_id = ?`,
  ).bind(
    after.best_score, after.level, after.achieved_at, now, after.manual_rank,
    after.admin_note ?? null, after.verification_status, playerId,
  ));
  const auditId = newId();
  statements.push(
    auditStatement(env, {
      id: auditId,
      actor: admin.actor,
      action: 'leaderboard.update',
      targetType: 'leaderboard_entry',
      targetId: playerId,
      before,
      after,
      reason: optionalText(body.reason, 500, 'reason'),
      createdAt: now,
    }),
    backupOutboxStatement(env.DB, {
      entity_type: 'leaderboard_entry',
      entity_id: playerId,
      subject_player_id: playerId,
      payload: after,
      occurred_at: now,
    }),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      throw new HttpError(409, 'leaderboard_conflict', 'Name or manual rank conflicts with another player.');
    }
    throw error;
  }
  return { audit_id: auditId, entry: (await adminLeaderboardRow(env, playerId))! };
}

export async function deleteLeaderboardEntry(
  request: Request,
  env: Env,
  admin: AdminAuth,
  playerId: string,
): Promise<{ audit_id: string; deleted: true }> {
  const before = await adminLeaderboardRow(env, playerId);
  if (!before) throw new HttpError(404, 'leaderboard_entry_not_found', 'Leaderboard entry was not found.');
  if (before.deleted_at) throw new HttpError(409, 'already_deleted', 'Leaderboard entry is already deleted.');
  let reason: string | null = null;
  if (request.headers.get('content-length') !== '0') {
    try {
      const body = await readJson<Record<string, unknown>>(request);
      reason = optionalText(body.reason, 500, 'reason') ?? null;
    } catch (error) {
      if (!(error instanceof HttpError && error.code === 'invalid_json')) throw error;
    }
  }
  const now = utcNow();
  const after = { ...before, deleted_at: now, updated_at: now };
  const auditId = newId();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE leaderboard_entries SET deleted_at = ?, updated_at = ? WHERE player_id = ?',
    ).bind(now, now, playerId),
    auditStatement(env, {
      id: auditId,
      actor: admin.actor,
      action: 'leaderboard.delete',
      targetType: 'leaderboard_entry',
      targetId: playerId,
      before,
      after,
      reason,
      createdAt: now,
    }),
    backupOutboxStatement(env.DB, {
      entity_type: 'leaderboard_entry',
      entity_id: playerId,
      subject_player_id: playerId,
      operation: 'delete',
      payload: after,
      occurred_at: now,
    }),
  ]);
  return { audit_id: auditId, deleted: true };
}

export async function reorderLeaderboard(
  request: Request,
  env: Env,
  admin: AdminAuth,
): Promise<{ audit_id: string; reordered: number }> {
  const body = await readJson<Record<string, unknown>>(request);
  if (!Array.isArray(body.player_ids) || body.player_ids.length > 500) {
    throw new HttpError(400, 'invalid_order', 'player_ids must be an array of no more than 500 player IDs.');
  }
  const playerIds = body.player_ids.map((value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{20,64}$/.test(value)) {
      throw new HttpError(400, 'invalid_order', 'player_ids contains an invalid player ID.');
    }
    return value;
  });
  if (new Set(playerIds).size !== playerIds.length) {
    throw new HttpError(400, 'invalid_order', 'player_ids cannot contain duplicates.');
  }
  const beforeResult = await env.DB.prepare(
    'SELECT player_id, manual_rank FROM leaderboard_entries WHERE deleted_at IS NULL ORDER BY player_id',
  ).all<{ player_id: string; manual_rank: number | null }>();
  const existing = new Set(beforeResult.results.map((row) => row.player_id));
  if (playerIds.some((id) => !existing.has(id))) {
    throw new HttpError(400, 'invalid_order', 'player_ids contains a missing or deleted leaderboard entry.');
  }
  const now = utcNow();
  const auditId = newId();
  const after = playerIds.map((player_id, index) => ({ player_id, manual_rank: index + 1 }));
  const completeRows = await Promise.all(playerIds.map((id) => adminLeaderboardRow(env, id)));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE leaderboard_entries SET manual_rank = NULL, updated_at = ? WHERE deleted_at IS NULL').bind(now),
  ];
  for (const row of after) {
    statements.push(env.DB.prepare(
      'UPDATE leaderboard_entries SET manual_rank = ?, updated_at = ? WHERE player_id = ? AND deleted_at IS NULL',
    ).bind(row.manual_rank, now, row.player_id));
    const complete = completeRows.find((entry) => entry?.player_id === row.player_id);
    if (complete) statements.push(backupOutboxStatement(env.DB, {
      entity_type: 'leaderboard_entry', entity_id: row.player_id, subject_player_id: row.player_id,
      payload: { ...complete, manual_rank: row.manual_rank, updated_at: now }, occurred_at: now,
    }));
  }
  statements.push(
    auditStatement(env, {
      id: auditId,
      actor: admin.actor,
      action: 'leaderboard.reorder',
      targetType: 'leaderboard',
      before: beforeResult.results,
      after,
      reason: optionalText(body.reason, 500, 'reason'),
      createdAt: now,
    }),
    backupOutboxStatement(env.DB, {
      entity_type: 'leaderboard_order',
      entity_id: 'global',
      payload: after,
      occurred_at: now,
    }),
  );
  await env.DB.batch(statements);
  return { audit_id: auditId, reordered: playerIds.length };
}

export async function createClearChallenge(
  env: Env,
  admin: AdminAuth,
): Promise<{ challenge_id: string; expires_at: string; confirmation_number: 1; backup_behavior: string }> {
  const challengeId = newId();
  const now = utcNow();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_confirmation_challenges (id, actor, action, created_at, expires_at)
     VALUES (?, ?, 'leaderboard.clear_primary', ?, ?)`,
  ).bind(challengeId, admin.actor, now, expiresAt).run();
  return {
    challenge_id: challengeId,
    expires_at: expiresAt,
    confirmation_number: 1,
    backup_behavior: 'The primary leaderboard will be cleared; the backup database will remain unchanged.',
  };
}

export async function createRestoreChallenge(
  env: Env,
  admin: AdminAuth,
): Promise<{ challenge_id: string; expires_at: string; confirmation_number: 1; backup_behavior: string }> {
  const challengeId = newId();
  const now = utcNow();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_confirmation_challenges (id, actor, action, created_at, expires_at)
     VALUES (?, ?, 'leaderboard.restore_from_backup', ?, ?)`,
  ).bind(challengeId, admin.actor, now, expiresAt).run();
  return {
    challenge_id: challengeId,
    expires_at: expiresAt,
    confirmation_number: 1,
    backup_behavior: 'The primary leaderboard will be rebuilt from redundant backup score history; the raw backup will remain unchanged.',
  };
}

export async function clearPrimaryLeaderboard(
  request: Request,
  env: Env,
  admin: AdminAuth,
): Promise<{ audit_id: string; batch_id: string; snapshot_id: string; cleared_entries: number; backup_modified: false }> {
  const body = await readJson<Record<string, unknown>>(request);
  if (
    typeof body.challenge_id !== 'string'
    || body.confirmation_1 !== true
    || body.confirmation_2 !== true
    || body.confirmation_phrase !== 'CLEAR PRIMARY ONLY'
  ) {
    throw new HttpError(400, 'double_confirmation_required', 'Two confirmations are required to clear the primary leaderboard.');
  }
  const challenge = await env.DB.prepare(
    `SELECT id, actor FROM admin_confirmation_challenges
     WHERE id = ? AND action = 'leaderboard.clear_primary' AND used_at IS NULL AND expires_at > ?`,
  ).bind(body.challenge_id, utcNow()).first<{ id: string; actor: string }>();
  if (!challenge || challenge.actor !== admin.actor) {
    throw new HttpError(409, 'confirmation_expired', 'Clear confirmation is missing, expired, or already used.');
  }
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM leaderboard_entries WHERE deleted_at IS NULL',
  ).first<{ total: number }>();
  const rowCount = count?.total ?? 0;
  const now = utcNow();
  const auditId = newId();
  const batchId = newId();
  const snapshotId = newId();
  const reason = optionalText(body.reason, 500, 'reason');

  // Deliberately no backup_outbox row and no BACKUP_DB call here. This is the
  // product requirement: clear only the primary/global leaderboard while the
  // raw backup remains untouched and available for recovery.
  await env.DB.batch([
    ...snapshotStatements(env, { id: snapshotId, actor: admin.actor, reason, trigger: 'pre_clear', source: auditId, createdAt: now }),
    auditStatement(env, {
      id: auditId,
      actor: admin.actor,
      action: 'leaderboard.clear_primary',
      targetType: 'leaderboard',
      targetId: batchId,
      before: { active_entries: rowCount, batch_id: batchId, snapshot_id: snapshotId },
      after: { active_entries: 0, backup_modified: false, batch_id: batchId, snapshot_id: snapshotId },
      reason,
      createdAt: now,
    }),
    env.DB.prepare(
      `INSERT INTO leaderboard_clear_batches
        (id, audit_log_id, actor, reason, cleared_at, row_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(batchId, auditId, admin.actor, reason ?? null, now, rowCount),
    env.DB.prepare(
      `INSERT INTO leaderboard_clear_batch_items (batch_id, player_id, previous_deleted_at)
       SELECT ?, player_id, deleted_at FROM leaderboard_entries WHERE deleted_at IS NULL`,
    ).bind(batchId),
    env.DB.prepare(
      'UPDATE leaderboard_entries SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL',
    ).bind(now, now),
    env.DB.prepare(
      'UPDATE admin_confirmation_challenges SET used_at = ? WHERE id = ?',
    ).bind(now, challenge.id),
  ]);
  return { audit_id: auditId, batch_id: batchId, snapshot_id: snapshotId, cleared_entries: rowCount, backup_modified: false };
}

interface BackupScorePayload {
  player_id: string;
  score: number;
  level: number | null;
  submitted_at: string;
  source_platform: string;
  web_source: string | null;
  device_type: string;
  control_type: string | null;
  app_version: string | null;
}

function validBackupScore(value: unknown): value is BackupScorePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.player_id === 'string'
    && typeof row.score === 'number'
    && Number.isInteger(row.score)
    && row.score > 0
    && row.score < 100_000_000
    && typeof row.submitted_at === 'string'
    && ['android', 'ios', 'web'].includes(String(row.source_platform))
    && ['phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown'].includes(String(row.device_type));
}

export async function restorePrimaryLeaderboardFromBackup(
  request: Request,
  env: Env,
  admin: AdminAuth,
): Promise<{ audit_id: string; restored_entries: number; backup_modified: false }> {
  const body = await readJson<Record<string, unknown>>(request);
  if (
    typeof body.challenge_id !== 'string'
    || body.confirmation_1 !== true
    || body.confirmation_2 !== true
    || body.confirmation_phrase !== 'RESTORE PRIMARY FROM BACKUP'
  ) {
    throw new HttpError(400, 'double_confirmation_required', 'Two confirmations are required to restore the primary leaderboard.');
  }
  const challenge = await env.DB.prepare(
    `SELECT id, actor FROM admin_confirmation_challenges
     WHERE id = ? AND action = 'leaderboard.restore_from_backup' AND used_at IS NULL AND expires_at > ?`,
  ).bind(body.challenge_id, utcNow()).first<{ id: string; actor: string }>();
  if (!challenge || challenge.actor !== admin.actor) {
    throw new HttpError(409, 'confirmation_expired', 'Restore confirmation is missing, expired, or already used.');
  }

  const backupRows = await env.BACKUP_DB.prepare(
    `SELECT payload_json FROM backup_entity_snapshots
     WHERE entity_type = 'score_submission' AND operation = 'upsert' AND payload_json IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT 100000`,
  ).all<{ payload_json: string }>();
  const bestByPlayer = new Map<string, BackupScorePayload>();
  for (const row of backupRows.results) {
    let candidate: unknown;
    try { candidate = JSON.parse(row.payload_json); } catch { continue; }
    if (!validBackupScore(candidate)) continue;
    const existing = bestByPlayer.get(candidate.player_id);
    if (
      !existing
      || candidate.score > existing.score
      || (candidate.score === existing.score && candidate.submitted_at < existing.submitted_at)
    ) {
      bestByPlayer.set(candidate.player_id, candidate);
    }
  }
  const batchId = newId();
  const now = utcNow();
  const candidates = [...bestByPlayer.values()];
  for (let index = 0; index < candidates.length; index += 100) {
    const chunk = candidates.slice(index, index + 100);
    await env.DB.batch(chunk.map((row) => env.DB.prepare(
      `INSERT INTO leaderboard_restore_staging
        (batch_id, player_id, best_score, level, achieved_at, source_platform, web_source,
         device_type, control_type, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      batchId, row.player_id, row.score, row.level ?? null, safeIsoUtc(row.submitted_at, 'submitted_at'),
      row.source_platform, row.web_source ?? null, row.device_type, row.control_type ?? 'unknown',
      row.app_version ?? null,
    )));
  }
  const before = await env.DB.prepare(
    'SELECT COUNT(*) AS active_entries FROM leaderboard_entries WHERE deleted_at IS NULL',
  ).first<{ active_entries: number }>();
  const restorable = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM leaderboard_restore_staging s JOIN players p ON p.id = s.player_id
     WHERE s.batch_id = ? AND p.deleted_at IS NULL`,
  ).bind(batchId).first<{ total: number }>();
  const auditId = newId();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO leaderboard_entries
          (player_id, best_score, level, achieved_at, updated_at, source_platform, web_source,
           device_type, control_type, app_version, verification_status, deleted_at)
         SELECT
           s.player_id, s.best_score, s.level, s.achieved_at, ?, s.source_platform, s.web_source,
           s.device_type, s.control_type, s.app_version, 'unverified', NULL
         FROM leaderboard_restore_staging s
         JOIN players p ON p.id = s.player_id
         WHERE s.batch_id = ? AND p.deleted_at IS NULL
         ON CONFLICT(player_id) DO UPDATE SET
           best_score = CASE WHEN excluded.best_score > leaderboard_entries.best_score THEN excluded.best_score ELSE leaderboard_entries.best_score END,
           level = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.level ELSE leaderboard_entries.level END,
           achieved_at = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.achieved_at ELSE leaderboard_entries.achieved_at END,
           updated_at = excluded.updated_at,
           source_platform = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.source_platform ELSE leaderboard_entries.source_platform END,
           web_source = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.web_source ELSE leaderboard_entries.web_source END,
           device_type = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.device_type ELSE leaderboard_entries.device_type END,
           control_type = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.control_type ELSE leaderboard_entries.control_type END,
           app_version = CASE WHEN excluded.best_score >= leaderboard_entries.best_score THEN excluded.app_version ELSE leaderboard_entries.app_version END,
           deleted_at = NULL`,
      ).bind(now, batchId),
      auditStatement(env, {
        id: auditId,
        actor: admin.actor,
        action: 'leaderboard.restore_from_backup',
        targetType: 'leaderboard',
        targetId: batchId,
        before: before ?? { active_entries: 0 },
        after: { restored_entries: restorable?.total ?? 0, backup_modified: false },
        reason: optionalText(body.reason, 500, 'reason'),
        createdAt: now,
      }),
      env.DB.prepare('DELETE FROM leaderboard_restore_staging WHERE batch_id = ?').bind(batchId),
      env.DB.prepare('UPDATE admin_confirmation_challenges SET used_at = ? WHERE id = ?').bind(now, challenge.id),
    ]);
  } catch (error) {
    await env.DB.prepare('DELETE FROM leaderboard_restore_staging WHERE batch_id = ?').bind(batchId).run();
    throw error;
  }
  // Restore reads backup and writes primary only. The backup is already the
  // source of truth for this operation; later gameplay/admin changes resume
  // normal outbox replication to both databases.
  return { audit_id: auditId, restored_entries: restorable?.total ?? 0, backup_modified: false };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function undoAdminAction(
  env: Env,
  admin: AdminAuth,
  auditId: string,
): Promise<{ audit_id: string; undone: true }> {
  const audit = await env.DB.prepare(
    `SELECT id, action, target_id, before_json, after_json, undone_at
     FROM admin_audit_logs WHERE id = ?`,
  ).bind(auditId).first<AuditRow>();
  if (!audit) throw new HttpError(404, 'audit_not_found', 'Audit action was not found.');
  if (audit.undone_at) throw new HttpError(409, 'already_undone', 'Audit action has already been undone.');
  const now = utcNow();
  const statements: D1PreparedStatement[] = [];
  if (audit.action === 'leaderboard.update' || audit.action === 'leaderboard.delete') {
    const before = parseJson<LeaderboardRow | null>(audit.before_json, null);
    if (!before) throw new HttpError(409, 'undo_unavailable', 'The prior state is unavailable.');
    statements.push(
      env.DB.prepare(
        'UPDATE players SET display_name = ?, normalized_name = ?, updated_at = ? WHERE id = ?',
      ).bind(before.display_name, before.display_name.toUpperCase(), now, before.player_id),
      env.DB.prepare(
        `UPDATE leaderboard_entries SET
           best_score = ?, level = ?, achieved_at = ?, updated_at = ?, source_platform = ?,
           web_source = ?, device_type = ?, control_type = ?, app_version = ?, verification_status = ?,
           manual_rank = ?, admin_note = ?, deleted_at = ?
         WHERE player_id = ?`,
      ).bind(
        before.best_score, before.level, before.achieved_at, now, before.source_platform,
        before.web_source, before.device_type, before.control_type, before.app_version,
        before.verification_status, before.manual_rank, before.admin_note ?? null,
        before.deleted_at ?? null, before.player_id,
      ),
      backupOutboxStatement(env.DB, {
        entity_type: 'leaderboard_entry',
        entity_id: before.player_id,
        subject_player_id: before.player_id,
        payload: before,
        occurred_at: now,
      }),
    );
  } else if (audit.action === 'leaderboard.reorder') {
    const before = parseJson<Array<{ player_id: string; manual_rank: number | null }>>(audit.before_json, []);
    statements.push(env.DB.prepare('UPDATE leaderboard_entries SET manual_rank = NULL, updated_at = ?').bind(now));
    for (const row of before) {
      statements.push(env.DB.prepare(
        'UPDATE leaderboard_entries SET manual_rank = ?, updated_at = ? WHERE player_id = ?',
      ).bind(row.manual_rank, now, row.player_id));
    }
    statements.push(backupOutboxStatement(env.DB, {
      entity_type: 'leaderboard_order', entity_id: 'global', payload: before, occurred_at: now,
    }));
  } else if (audit.action === 'leaderboard.clear_primary') {
    const batchId = audit.target_id;
    if (!batchId) throw new HttpError(409, 'undo_unavailable', 'Clear batch is unavailable.');
    const batch = await env.DB.prepare(
      'SELECT id, undone_at FROM leaderboard_clear_batches WHERE id = ?',
    ).bind(batchId).first<{ id: string; undone_at: string | null }>();
    if (!batch || batch.undone_at) throw new HttpError(409, 'undo_unavailable', 'Clear batch cannot be undone.');
    statements.push(
      env.DB.prepare(
        `UPDATE leaderboard_entries
         SET deleted_at = (
           SELECT i.previous_deleted_at
           FROM leaderboard_clear_batch_items i
           WHERE i.batch_id = ? AND i.player_id = leaderboard_entries.player_id
         ), updated_at = ?
         WHERE player_id IN (
           SELECT player_id FROM leaderboard_clear_batch_items WHERE batch_id = ?
         )`,
      ).bind(batchId, now, batchId),
      env.DB.prepare(
        'UPDATE leaderboard_clear_batches SET undone_at = ?, undone_by = ? WHERE id = ?',
      ).bind(now, admin.actor, batchId),
    );
    // As with the clear itself, undoing a primary-only clear does not mutate
    // the backup; the backup already holds the preserved pre-clear state.
  } else {
    throw new HttpError(409, 'undo_unsupported', 'This audit action cannot be undone automatically.');
  }
  statements.push(env.DB.prepare(
    'UPDATE admin_audit_logs SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL',
  ).bind(now, admin.actor, audit.id));
  await env.DB.batch(statements);
  return { audit_id: audit.id, undone: true };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

export async function exportLeaderboardCsv(env: Env): Promise<string> {
  const { entries } = await getLeaderboard(env, 5000, 0, true);
  const headers = [
    'rank', 'player_id', 'display_name', 'best_score', 'level', 'achieved_at', 'updated_at',
    'source_platform', 'web_source', 'device_type', 'control_type', 'app_version',
    'verification_status', 'manual_rank', 'admin_note', 'deleted_at',
  ];
  return [headers.join(','), ...entries.map((entry) => headers.map((key) => csvCell(entry[key as keyof LeaderboardRow])).join(','))].join('\r\n');
}

export async function analyticsSummary(env: Env, url: URL): Promise<Record<string, unknown>> {
  const from = safeIsoUtc(url.searchParams.get('from'), 'from', new Date(Date.now() - 30 * 86_400_000).toISOString());
  const to = safeIsoUtc(url.searchParams.get('to'), 'to');
  const [totals, events, platforms, levels, controls, hours, countries] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT installation_id) AS installations,
              COUNT(DISTINCT player_id) AS players, COUNT(DISTINCT session_id) AS sessions
       FROM analytics_events WHERE occurred_at BETWEEN ? AND ?`,
    ).bind(from, to).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT event_name, COUNT(*) AS total FROM analytics_events
       WHERE occurred_at BETWEEN ? AND ? GROUP BY event_name ORDER BY total DESC`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT source_platform, web_source, device_type, COUNT(DISTINCT installation_id) AS installations
       FROM analytics_events WHERE occurred_at BETWEEN ? AND ?
       GROUP BY source_platform, web_source, device_type ORDER BY installations DESC`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT level, COUNT(*) AS starts,
              SUM(CASE WHEN event_name = 'level_end' AND outcome IN ('completed', 'won') THEN 1 ELSE 0 END) AS completions,
              AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_duration_ms
       FROM analytics_events
       WHERE occurred_at BETWEEN ? AND ? AND event_name IN ('level_start', 'level_end') AND level IS NOT NULL
       GROUP BY level ORDER BY level`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT control_type, COUNT(*) AS total FROM analytics_events
       WHERE occurred_at BETWEEN ? AND ? AND control_type IS NOT NULL
       GROUP BY control_type ORDER BY total DESC`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT strftime('%H', occurred_at) AS utc_hour, COUNT(*) AS total FROM analytics_events
       WHERE occurred_at BETWEEN ? AND ? AND event_name IN ('app_open', 'session_start')
       GROUP BY utc_hour ORDER BY utc_hour`,
    ).bind(from, to).all(),
    env.DB.prepare(
      `SELECT country_code, region_code, COUNT(DISTINCT installation_id) AS installations
       FROM analytics_events WHERE occurred_at BETWEEN ? AND ? AND country_code IS NOT NULL
       GROUP BY country_code, region_code ORDER BY installations DESC LIMIT 100`,
    ).bind(from, to).all(),
  ]);
  return {
    range: { from, to, timezone: 'UTC' },
    totals: totals ?? {},
    events: events.results,
    platforms: platforms.results,
    levels: levels.results,
    controls: controls.results,
    favorite_play_hours_utc: hours.results,
    coarse_geography: countries.results,
  };
}

export async function backupStatus(env: Env): Promise<Record<string, unknown>> {
  const [pending, primaryLatest, backupLatest, backupEvents] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS pending, MIN(occurred_at) AS oldest_pending,
              MAX(attempt_count) AS max_attempts
       FROM backup_outbox WHERE dispatched_at IS NULL`,
    ).first(),
    env.DB.prepare('SELECT MAX(dispatched_at) AS last_dispatched_at FROM backup_outbox').first(),
    env.BACKUP_DB.prepare('SELECT MAX(backed_up_at) AS last_backed_up_at FROM backup_events').first(),
    env.BACKUP_DB.prepare('SELECT COUNT(*) AS total_events FROM backup_events').first(),
  ]);
  return {
    primary_outbox: pending ?? {},
    primary_latest: primaryLatest ?? {},
    backup_latest: backupLatest ?? {},
    backup_events: backupEvents ?? {},
    clear_behavior: 'Primary-only global leaderboard clears are intentionally excluded from backup replication.',
  };
}

export async function listAuditLogs(env: Env, url: URL): Promise<unknown[]> {
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const result = await env.DB.prepare(
    `SELECT id, actor, action, target_type, target_id, reason, created_at, undone_at, undone_by
     FROM admin_audit_logs ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return result.results;
}
