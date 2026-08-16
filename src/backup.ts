import { newId, utcNow } from './http';
import type { BackupOutboxRow, Env } from './types';

export function backupOutboxStatement(
  db: D1Database,
  input: {
    entity_type: string;
    entity_id: string;
    subject_player_id?: string | null;
    operation?: 'upsert' | 'delete' | 'privacy_delete';
    payload?: unknown;
    occurred_at?: string;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO backup_outbox
      (id, entity_type, entity_id, subject_player_id, operation, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId(),
    input.entity_type,
    input.entity_id,
    input.subject_player_id ?? null,
    input.operation ?? 'upsert',
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.occurred_at ?? utcNow(),
  );
}

async function applyBackupEvent(env: Env, row: BackupOutboxRow): Promise<void> {
  const backedUpAt = utcNow();
  if (row.operation === 'privacy_delete') {
    const subject = row.subject_player_id || row.entity_id;
    await env.BACKUP_DB.batch([
      env.BACKUP_DB.prepare(
        `UPDATE backup_events
         SET payload_json = NULL, operation = 'privacy_redacted'
         WHERE subject_player_id = ?`,
      ).bind(subject),
      env.BACKUP_DB.prepare(
        'DELETE FROM backup_entity_snapshots WHERE subject_player_id = ?',
      ).bind(subject),
      env.BACKUP_DB.prepare(
        'DELETE FROM managed_leaderboard_state WHERE player_id = ?',
      ).bind(subject),
      env.BACKUP_DB.prepare(
        `INSERT INTO backup_privacy_deletions (player_id, deleted_at, source_outbox_id)
         VALUES (?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           deleted_at = excluded.deleted_at,
           source_outbox_id = excluded.source_outbox_id`,
      ).bind(subject, row.occurred_at, row.id),
      env.BACKUP_DB.prepare(
        `INSERT OR IGNORE INTO backup_events
          (source_outbox_id, entity_type, entity_id, subject_player_id, operation, payload_json, occurred_at, backed_up_at)
         VALUES (?, 'player', ?, ?, 'privacy_delete', NULL, ?, ?)`,
      ).bind(row.id, subject, subject, row.occurred_at, backedUpAt),
    ]);
    return;
  }

  const statements: D1PreparedStatement[] = [
    env.BACKUP_DB.prepare(
      `INSERT OR IGNORE INTO backup_events
        (source_outbox_id, entity_type, entity_id, subject_player_id, operation, payload_json, occurred_at, backed_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.entity_type,
      row.entity_id,
      row.subject_player_id,
      row.operation,
      row.payload_json,
      row.occurred_at,
      backedUpAt,
    ),
    env.BACKUP_DB.prepare(
      `INSERT INTO backup_entity_snapshots
        (entity_type, entity_id, subject_player_id, payload_json, source_outbox_id, operation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         subject_player_id = excluded.subject_player_id,
         payload_json = excluded.payload_json,
         source_outbox_id = excluded.source_outbox_id,
         operation = excluded.operation,
         updated_at = excluded.updated_at`,
    ).bind(
      row.entity_type,
      row.entity_id,
      row.subject_player_id,
      row.payload_json,
      row.id,
      row.operation,
      backedUpAt,
    ),
  ];
  // Managed state is independent from immutable forensic events. Only complete
  // leaderboard payloads are projected; direct backup administration never
  // changes backup_events.
  if (row.entity_type === 'leaderboard_entry' && row.payload_json) {
    let value: Record<string, unknown> | null = null;
    try { value = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { value = null; }
    if (value && typeof value.best_score === 'number' && typeof value.display_name === 'string') {
      const action = value.deleted_at ? 'soft_deleted' : (row.operation === 'delete' ? 'soft_deleted' : 'replicated');
      statements.push(env.BACKUP_DB.prepare(`INSERT INTO managed_leaderboard_state
        (player_id,display_name,best_score,level,achieved_at,updated_at,source_platform,web_source,
         device_type,control_type,app_version,verification_status,manual_rank,admin_note,deleted_at,
         latest_action_type,latest_action_at,source_action_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(player_id) DO UPDATE SET display_name=excluded.display_name,best_score=excluded.best_score,
         level=excluded.level,achieved_at=excluded.achieved_at,updated_at=excluded.updated_at,
         source_platform=excluded.source_platform,web_source=excluded.web_source,device_type=excluded.device_type,
         control_type=excluded.control_type,app_version=excluded.app_version,verification_status=excluded.verification_status,
         manual_rank=excluded.manual_rank,admin_note=excluded.admin_note,deleted_at=excluded.deleted_at,
         latest_action_type=excluded.latest_action_type,latest_action_at=excluded.latest_action_at,source_action_id=excluded.source_action_id`).bind(
        row.entity_id, value.display_name, value.best_score, value.level ?? null, value.achieved_at,
        value.updated_at ?? row.occurred_at, value.source_platform, value.web_source ?? null, value.device_type,
        value.control_type ?? null, value.app_version ?? null, value.verification_status ?? 'unverified',
        value.manual_rank ?? null, value.admin_note ?? null, value.deleted_at ?? null, action, row.occurred_at, row.id,
      ));
    }
  }
  await env.BACKUP_DB.batch(statements);
}

export async function flushBackupOutbox(env: Env, limit = 100): Promise<{ processed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, entity_type, entity_id, subject_player_id, operation, payload_json, occurred_at, attempt_count
     FROM backup_outbox
     WHERE dispatched_at IS NULL
     ORDER BY occurred_at ASC
     LIMIT ?`,
  ).bind(Math.max(1, Math.min(500, limit))).all<BackupOutboxRow>();
  let processed = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await applyBackupEvent(env, row);
      await env.DB.prepare(
        'UPDATE backup_outbox SET dispatched_at = ?, attempt_count = attempt_count + 1, last_error = NULL WHERE id = ?',
      ).bind(utcNow(), row.id).run();
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown backup error';
      await env.DB.prepare(
        'UPDATE backup_outbox SET attempt_count = attempt_count + 1, last_error = ? WHERE id = ?',
      ).bind(message, row.id).run();
      failed += 1;
    }
  }
  return { processed, failed };
}
