import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
}

let mf: Miniflare;
let playerToken = '';
let playerId = '';

const playerMeta = {
  installation_id: 'test_installation_1234567890',
  source_platform: 'web',
  web_source: 'desktop_web',
  device_type: 'desktop',
  device_model: 'Test Browser',
  os_name: 'Test OS',
  os_version: '1',
  app_version: '0.1-test',
  control_type: 'keyboard',
};

async function json<T>(response: { json(): Promise<unknown> }): Promise<ApiEnvelope<T>> {
  return response.json() as Promise<ApiEnvelope<T>>;
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer integration-admin-token',
    'X-Admin-Actor': 'integration-test',
    'Content-Type': 'application/json',
  };
}

async function applySql(db: D1Database, sql: string): Promise<void> {
  const withoutLineComments = sql.replace(/^\s*--.*$/gm, '');
  for (const statement of withoutLineComments.split(';').map((part) => part.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error('Worker bundle was not produced.');
  mf = new Miniflare({
    workers: [{
      config: {
        name: 'cvd-integration-test',
        type: 'worker',
        compatibilityDate: '2026-08-01',
        manifest: {
          mainModule: 'index.mjs',
          modulesRoot: new URL('../', import.meta.url).pathname,
          modules: {
            'index.mjs': { type: 'esm', contents: script },
          },
        },
        env: {
          DB: { type: 'd1', id: 'cvd-test-main', name: 'cvd-test-main' },
          BACKUP_DB: { type: 'd1', id: 'cvd-test-backup', name: 'cvd-test-backup' },
          ENVIRONMENT: { type: 'text', value: 'test' },
          ALLOWED_ORIGINS: { type: 'text', value: 'https://www.cavemanvsdragon.com' },
          PUBLIC_API_URL: { type: 'text', value: 'https://api.example' },
          WEB_APP_URL: { type: 'text', value: 'https://www.cavemanvsdragon.com' },
          ANDROID_STORE_URL: { type: 'text', value: 'https://play.example/cvd' },
          IOS_STORE_URL: { type: 'text', value: 'https://apps.example/cvd' },
          SESSION_TTL_DAYS: { type: 'text', value: '30' },
          PASSWORD_ITERATIONS: { type: 'text', value: '100000' },
          ADMIN_API_TOKEN: { type: 'text', value: 'integration-admin-token' },
          RATE_LIMIT_SECRET: { type: 'text', value: 'integration-rate-limit-secret-that-is-not-production' },
        },
      },
    }],
  });
  const mainDb = await mf.getD1Database('DB');
  const backupDb = await mf.getD1Database('BACKUP_DB');
  await applySql(mainDb, readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  await applySql(backupDb, readFileSync(new URL('../backup-migrations/0001_backup.sql', import.meta.url), 'utf8'));
});

afterAll(async () => {
  await mf?.dispose();
});

describe.sequential('Worker + D1 integration', () => {
  it('reports health and server policy', async () => {
    const health = await mf.dispatchFetch('https://api.example/health');
    expect(health.status).toBe(200);
    expect((await json<{ status: string }>(health)).data.status).toBe('ok');
    const config = await mf.dispatchFetch('https://api.example/v1/config');
    expect((await json<{ global_leaderboard_policy: string }>(config)).data.global_leaderboard_policy)
      .toBe('one_entry_per_player_highest_score_only');
  });

  it('registers an account and records its first score in one flow', async () => {
    const response = await mf.dispatchFetch('https://api.example/v1/accounts/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
      body: JSON.stringify({
        name: 'Rock Hero',
        password: 'safe-test-password',
        initial_score: 12500,
        initial_level: 3,
        ...playerMeta,
      }),
    });
    expect(response.status).toBe(201);
    const payload = await json<{
      player: { id: string; display_name: string };
      session: { token: string };
      initial_score: { improved: boolean };
    }>(response);
    expect(payload.data.player.display_name).toBe('Rock Hero');
    expect(payload.data.initial_score.improved).toBe(true);
    playerId = payload.data.player.id;
    playerToken = payload.data.session.token;
    const db = await mf.getD1Database('DB');
    const stored = await db.prepare(
      'SELECT password_iterations FROM players WHERE id = ?',
    ).bind(playerId).first<{ password_iterations: number }>();
    expect(stored?.password_iterations).toBe(100_000);
  });

  it('keeps exactly one global entry per player and only the highest score', async () => {
    const submit = async (score: number) => mf.dispatchFetch('https://api.example/v1/scores', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + playerToken,
        'CF-Connecting-IP': '203.0.113.55',
      },
      body: JSON.stringify({ score, level: 4, ...playerMeta }),
    });
    expect((await json<{ improved: boolean }>(await submit(100))).data.improved).toBe(false);
    expect((await json<{ improved: boolean }>(await submit(25000))).data.improved).toBe(true);
    const leaderboard = await json<{ entries: Array<{ player_id: string; best_score: number }>; total: number }>(
      await mf.dispatchFetch('https://api.example/v1/leaderboard'),
    );
    expect(leaderboard.data.total).toBe(1);
    expect(leaderboard.data.entries).toEqual([
      expect.objectContaining({ player_id: playerId, best_score: 25000 }),
    ]);
  });

  it('accepts rich privacy-minimized analytics without persisting a raw IP', async () => {
    const response = await mf.dispatchFetch('https://api.example/v1/analytics/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + playerToken,
        'CF-Connecting-IP': '203.0.113.55',
      },
      body: JSON.stringify({
        ...playerMeta,
        events: [
          { event_id: 'event_session_start_001', event_name: 'session_start', session_id: 'session_test_001', occurred_at: '2026-08-13T20:00:00Z' },
          { event_id: 'event_level_end_00001', event_name: 'level_end', session_id: 'session_test_001', level: 2, score: 9000, duration_ms: 45000, outcome: 'completed', occurred_at: '2026-08-13T20:02:00Z' },
        ],
      }),
    });
    expect(response.status).toBe(202);
    const db = await mf.getD1Database('DB');
    const event = await db.prepare(
      'SELECT device_model, os_name, country_code, region_code FROM analytics_events WHERE id = ?',
    ).bind('event_level_end_00001').first<Record<string, unknown>>();
    expect(event).toMatchObject({ device_model: 'Test Browser', os_name: 'Test OS' });
    const schema = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'analytics_events'").first<{ sql: string }>();
    expect(schema?.sql).not.toMatch(/ip_address|imei|advertising_id|mac_address|gps/i);
    const limiter = await db.prepare('SELECT identifier_hash FROM rate_limit_windows LIMIT 1').first<{ identifier_hash: string }>();
    expect(limiter?.identifier_hash).not.toContain('203.0.113.55');
  });

  it('requires two confirmations, clears only primary, and can undo the clear', async () => {
    const backupDb = await mf.getD1Database('BACKUP_DB');
    const beforeBackup = await backupDb.prepare('SELECT COUNT(*) AS total FROM backup_events').first<{ total: number }>();
    const rejected = await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmation_1: true }),
    });
    expect(rejected.status).toBe(400);

    const challengeResponse = await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear/challenge', {
      method: 'POST', headers: adminHeaders(), body: '{}',
    });
    const challenge = await json<{ challenge_id: string }>(challengeResponse);
    const clearResponse = await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        challenge_id: challenge.data.challenge_id,
        confirmation_1: true,
        confirmation_2: true,
        confirmation_phrase: 'CLEAR PRIMARY ONLY',
      }),
    });
    expect(clearResponse.status).toBe(200);
    const cleared = await json<{ audit_id: string; cleared_entries: number; backup_modified: boolean }>(clearResponse);
    expect(cleared.data).toMatchObject({ cleared_entries: 1, backup_modified: false });
    const empty = await json<{ total: number }>(await mf.dispatchFetch('https://api.example/v1/leaderboard'));
    expect(empty.data.total).toBe(0);
    const afterBackup = await backupDb.prepare('SELECT COUNT(*) AS total FROM backup_events').first<{ total: number }>();
    expect(afterBackup?.total).toBe(beforeBackup?.total);

    const undo = await mf.dispatchFetch(
      'https://api.example/v1/admin/audit/' + encodeURIComponent(cleared.data.audit_id) + '/undo',
      { method: 'POST', headers: adminHeaders(), body: '{}' },
    );
    expect(undo.status).toBe(200);
    const restored = await json<{ total: number }>(await mf.dispatchFetch('https://api.example/v1/leaderboard'));
    expect(restored.data.total).toBe(1);
  });

  it('restores the primary leaderboard from unchanged backup history', async () => {
    const backupDb = await mf.getD1Database('BACKUP_DB');
    const backupBefore = await backupDb.prepare('SELECT COUNT(*) AS total FROM backup_events').first<{ total: number }>();
    const clearChallenge = await json<{ challenge_id: string }>(await mf.dispatchFetch(
      'https://api.example/v1/admin/leaderboard/clear/challenge',
      { method: 'POST', headers: adminHeaders(), body: '{}' },
    ));
    const clear = await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        challenge_id: clearChallenge.data.challenge_id,
        confirmation_1: true,
        confirmation_2: true,
        confirmation_phrase: 'CLEAR PRIMARY ONLY',
      }),
    });
    expect(clear.status).toBe(200);
    const restoreChallenge = await json<{ challenge_id: string }>(await mf.dispatchFetch(
      'https://api.example/v1/admin/backups/restore-leaderboard/challenge',
      { method: 'POST', headers: adminHeaders(), body: '{}' },
    ));
    const restore = await mf.dispatchFetch('https://api.example/v1/admin/backups/restore-leaderboard', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        challenge_id: restoreChallenge.data.challenge_id,
        confirmation_1: true,
        confirmation_2: true,
        confirmation_phrase: 'RESTORE PRIMARY FROM BACKUP',
      }),
    });
    expect(restore.status).toBe(200);
    const result = await json<{ restored_entries: number; backup_modified: boolean }>(restore);
    expect(result.data).toMatchObject({ restored_entries: 1, backup_modified: false });
    const leaderboard = await json<{ total: number }>(await mf.dispatchFetch('https://api.example/v1/leaderboard'));
    expect(leaderboard.data.total).toBe(1);
    const backupAfter = await backupDb.prepare('SELECT COUNT(*) AS total FROM backup_events').first<{ total: number }>();
    expect(backupAfter?.total).toBe(backupBefore?.total);
  });
});
