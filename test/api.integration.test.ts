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
let mainDb: D1Database;
let backupDb: D1Database;

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
  const triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
  let remainder=sql;
  for(const trigger of triggers) remainder=remainder.replace(trigger,'');
  const statements=remainder.replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean);
  for(const statement of [...statements,...triggers.map(x=>x.replace(/;\s*$/,''))]) await db.prepare(statement).run();
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
  mainDb = await mf.getD1Database('DB');
  backupDb = await mf.getD1Database('BACKUP_DB');
  await applySql(mainDb, readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  await applySql(backupDb, readFileSync(new URL('../backup-migrations/0001_backup.sql', import.meta.url), 'utf8'));
  await applySql(mainDb, readFileSync(new URL('../migrations/0002_leaderboard_snapshots.sql', import.meta.url), 'utf8'));
  await applySql(mainDb, readFileSync(new URL('../migrations/0003_snapshot_archival.sql', import.meta.url), 'utf8'));
  await applySql(backupDb, readFileSync(new URL('../backup-migrations/0002_managed_leaderboard.sql', import.meta.url), 'utf8'));
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

  it('clear snapshots complete active and deleted state and snapshots are immutable', async () => {
    await mainDb.prepare(`UPDATE leaderboard_entries SET manual_rank=7,admin_note='keep-note',verification_status='flagged',deleted_at='2026-01-01T00:00:00Z' WHERE player_id=?`).bind(playerId).run();
    const challenge = await json<{challenge_id:string}>(await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear/challenge',{method:'POST',headers:adminHeaders(),body:'{}'}));
    const response=await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear',{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'CLEAR PRIMARY ONLY'})});
    const result=await json<{snapshot_id:string}>(response);expect(response.status).toBe(200);
    const snapshot=await mainDb.prepare('SELECT entry_count,trigger_type FROM primary_leaderboard_snapshots WHERE id=?').bind(result.data.snapshot_id).first<{entry_count:number;trigger_type:string}>();
    const entry=await mainDb.prepare('SELECT * FROM primary_leaderboard_snapshot_entries WHERE snapshot_id=? AND player_id=?').bind(result.data.snapshot_id,playerId).first<Record<string,unknown>>();
    expect(snapshot).toEqual({entry_count:1,trigger_type:'pre_clear'});
    expect(entry).toMatchObject({best_score:25000,manual_rank:7,admin_note:'keep-note',verification_status:'flagged',deleted_at:'2026-01-01T00:00:00Z',source_platform:'web',device_type:'desktop',control_type:'keyboard',app_version:'0.1-test'});
    await expect(mainDb.prepare('UPDATE primary_leaderboard_snapshots SET reason=? WHERE id=?').bind('changed',result.data.snapshot_id).run()).rejects.toThrow(/immutable/);
    await expect(mainDb.prepare('DELETE FROM primary_leaderboard_snapshot_entries WHERE snapshot_id=?').bind(result.data.snapshot_id).run()).rejects.toThrow(/immutable/);
  });

  it('snapshot creation failure atomically prevents primary clear', async () => {
    await mainDb.prepare('UPDATE leaderboard_entries SET deleted_at=NULL WHERE player_id=?').bind(playerId).run();
    await mainDb.prepare("CREATE TRIGGER fail_snapshot BEFORE INSERT ON primary_leaderboard_snapshots BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END").run();
    const ch=await json<{challenge_id:string}>(await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear/challenge',{method:'POST',headers:adminHeaders(),body:'{}'}));const before=(await mainDb.prepare('SELECT COUNT(*) total FROM primary_leaderboard_snapshots').first<{total:number}>())!.total;
    expect((await mf.dispatchFetch('https://api.example/v1/admin/leaderboard/clear',{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'CLEAR PRIMARY ONLY'})})).status).toBe(500);
    expect((await mainDb.prepare('SELECT deleted_at FROM leaderboard_entries WHERE player_id=?').bind(playerId).first<{deleted_at:string|null}>())?.deleted_at).toBeNull();expect((await mainDb.prepare('SELECT COUNT(*) total FROM primary_leaderboard_snapshots').first<{total:number}>())!.total).toBe(before);await mainDb.prepare('DROP TRIGGER fail_snapshot').run();
  });

  it('lists and views snapshots with pagination and rejects invalid IDs', async () => {
    const list=await json<Array<{id:string}>>(await mf.dispatchFetch('https://api.example/v1/admin/snapshots?limit=1',{headers:adminHeaders()}));expect(list.data).toHaveLength(1);
    const id=list.data[0]!.id;
    const page=await json<{entries:unknown[]}>(await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}?limit=1&offset=0`,{headers:adminHeaders()}));expect(page.data.entries).toHaveLength(1);
    expect((await mf.dispatchFetch('https://api.example/v1/admin/snapshots/bad',{headers:adminHeaders()})).status).toBe(400);
    expect((await mf.dispatchFetch('https://api.example/v1/admin/snapshots/00000000-0000-4000-8000-000000000000',{headers:adminHeaders()})).status).toBe(404);
  });

  it('archives snapshots with bound single-use confirmation, hides them, preserves contents, and audits unarchive', async () => {
    const active=await json<Array<{id:string;archived:number}>>(await mf.dispatchFetch('https://api.example/v1/admin/snapshots',{headers:adminHeaders()}));
    const id=active.data[0]!.id;
    const primaryBefore=(await mainDb.prepare('SELECT * FROM leaderboard_entries ORDER BY player_id').all()).results;
    const backupBefore=(await backupDb.prepare('SELECT * FROM managed_leaderboard_state ORDER BY player_id').all()).results;
    const expired=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive/challenge`,{method:'POST',headers:adminHeaders(),body:'{}'}));
    expect(await mainDb.prepare('SELECT actor,action FROM admin_confirmation_challenges WHERE id=?').bind(expired.data.challenge_id).first()).toEqual({actor:'integration-test',action:`snapshot.archive:${id}`});
    await mainDb.prepare("UPDATE admin_confirmation_challenges SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(expired.data.challenge_id).run();
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:expired.data.challenge_id,confirmation:true,second_confirmation:true,confirmation_phrase:expired.data.confirmation_phrase})})).status).toBe(409);
    const challenge=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive/challenge`,{method:'POST',headers:adminHeaders(),body:'{}'}));
    const wrongActor={...adminHeaders(),'X-Admin-Actor':'other'};
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive`,{method:'POST',headers:wrongActor,body:JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation:true,second_confirmation:true,confirmation_phrase:challenge.data.confirmation_phrase})})).status).toBe(409);
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation:true,second_confirmation:true,confirmation_phrase:'WRONG'})})).status).toBe(400);
    const body=JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation:true,second_confirmation:true,confirmation_phrase:challenge.data.confirmation_phrase,reason:'test archive'});
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive`,{method:'POST',headers:adminHeaders(),body})).status).toBe(200);
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/archive`,{method:'POST',headers:adminHeaders(),body})).status).toBe(409);
    const hidden=await json<Array<{id:string}>>(await mf.dispatchFetch('https://api.example/v1/admin/snapshots',{headers:adminHeaders()}));expect(hidden.data.some(x=>x.id===id)).toBe(false);
    const shown=await json<Array<{id:string;archived:number}>>(await mf.dispatchFetch('https://api.example/v1/admin/snapshots?include_archived=true',{headers:adminHeaders()}));expect(shown.data.find(x=>x.id===id)?.archived).toBe(1);
    const detail=await json<{entries:unknown[];snapshot:{archived:number}}>(await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}`,{headers:adminHeaders()}));expect(detail.data.snapshot.archived).toBe(1);expect(detail.data.entries.length).toBeGreaterThan(0);
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/restore/challenge`,{method:'POST',headers:adminHeaders(),body:'{}'})).status).toBe(404);
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/unarchive`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({confirmation:true,snapshot_id:id})})).status).toBe(200);
    expect((await mainDb.prepare("SELECT COUNT(*) total FROM admin_audit_logs WHERE target_id=? AND action IN ('snapshot.archive','snapshot.unarchive')").bind(id).first<{total:number}>())!.total).toBe(2);
    expect((await mainDb.prepare('SELECT * FROM leaderboard_entries ORDER BY player_id').all()).results).toEqual(primaryBefore);
    expect((await backupDb.prepare('SELECT * FROM managed_leaderboard_state ORDER BY player_id').all()).results).toEqual(backupBefore);
  });

  it('latest pre-clear ignores archived recovery points and reports a structured error', async()=>{
    const rows=await mainDb.prepare("SELECT id FROM primary_leaderboard_snapshots WHERE trigger_type='pre_clear'").all<{id:string}>();
    const now=new Date().toISOString();for(const row of rows.results)await mainDb.prepare(`INSERT INTO primary_snapshot_archive_state(snapshot_id,archived_at,archived_by,updated_at) VALUES(? ,?,'test',?) ON CONFLICT(snapshot_id) DO UPDATE SET unarchived_at=NULL,archived_at=excluded.archived_at,updated_at=excluded.updated_at`).bind(row.id,now,now).run();
    const response=await mf.dispatchFetch('https://api.example/v1/admin/snapshots/latest-pre-clear/restore/challenge',{method:'POST',headers:adminHeaders(),body:'{}'});expect(response.status).toBe(404);expect((await json<never>(response)).error?.code).toBe('no_active_pre_clear_snapshot');
    for(const row of rows.results)await mainDb.prepare("UPDATE primary_snapshot_archive_state SET unarchived_at=?,unarchived_by='test',updated_at=? WHERE snapshot_id=?").bind(new Date(Date.now()+1).toISOString(),new Date(Date.now()+1).toISOString(),row.id).run();
  });

  it('latest pre-clear selected restore requires exact confirmation and creates a safety snapshot', async () => {
    const ch=await json<{challenge_id:string;snapshot_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/snapshots/latest-pre-clear/restore/challenge',{method:'POST',headers:adminHeaders(),body:'{}'}));
    const wrong=await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${ch.data.snapshot_id}/restore`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'WRONG'})});expect(wrong.status).toBe(400);
    const good=await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${ch.data.snapshot_id}/restore`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:ch.data.confirmation_phrase})});
    const restored=await json<{safety_snapshot_id:string}>(good);expect(good.status).toBe(200);
    expect(await mainDb.prepare(`SELECT trigger_type,source_action_id FROM primary_leaderboard_snapshots WHERE id=?`).bind(restored.data.safety_snapshot_id).first()).toEqual({trigger_type:'pre_replace',source_action_id:ch.data.snapshot_id});
    expect((await mainDb.prepare('SELECT deleted_at FROM leaderboard_entries WHERE player_id=?').bind(playerId).first<{deleted_at:string}>())?.deleted_at).toBe('2026-01-01T00:00:00Z');
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${ch.data.snapshot_id}/restore`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:ch.data.confirmation_phrase})})).status).toBe(409);
  });

  it('rejects an incomplete selected snapshot without changing primary',async()=>{const id='11111111-1111-4111-8111-111111111111';await mainDb.prepare(`INSERT INTO primary_leaderboard_snapshots(id,created_at,actor,trigger_type,entry_count) VALUES(?,'2026-08-15T00:00:00Z','test','manual',1)`).bind(id).run();const before=await mainDb.prepare('SELECT * FROM leaderboard_entries').all();const ch=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/restore/challenge`,{method:'POST',headers:adminHeaders(),body:'{}'}));const response=await mf.dispatchFetch(`https://api.example/v1/admin/snapshots/${id}/restore`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:ch.data.confirmation_phrase})});expect(response.status).toBe(409);expect((await mainDb.prepare('SELECT * FROM leaderboard_entries').all()).results).toEqual(before.results);});

  it('restores one deleted primary row without changing score or metadata and queues complete backup state', async () => {
    const before=await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first<Record<string,unknown>>();
    const response=await mf.dispatchFetch(`https://api.example/v1/admin/leaderboard/${playerId}/restore`,{method:'POST',headers:adminHeaders(),body:'{}'});expect(response.status).toBe(200);
    const after=await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first<Record<string,unknown>>();expect(after).toMatchObject({...before,deleted_at:null,updated_at:expect.any(String)});
    expect(await mainDb.prepare(`SELECT action FROM admin_audit_logs WHERE action='leaderboard.restore_entry' AND target_id=?`).bind(playerId).first()).toEqual({action:'leaderboard.restore_entry'});
    const outbox=await mainDb.prepare(`SELECT payload_json FROM backup_outbox WHERE entity_type='leaderboard_entry' AND entity_id=? ORDER BY occurred_at DESC LIMIT 1`).bind(playerId).first<{payload_json:string}>();expect(JSON.parse(outbox!.payload_json)).toMatchObject({player_id:playerId,best_score:25000,deleted_at:null,admin_note:'keep-note'});
    expect((await mf.dispatchFetch(`https://api.example/v1/admin/leaderboard/${playerId}/restore`,{method:'POST',headers:adminHeaders(),body:'{}'})).status).toBe(409);
  });

  it('projects admin edit, delete, and restore into managed backup while events append', async () => {
    const eventsBefore=(await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total;
    const edit=await mf.dispatchFetch(`https://api.example/v1/admin/leaderboard/${playerId}`,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify({admin_note:'projected-note',verification_status:'verified'})});expect(edit.status).toBe(200);
    await mf.dispatchFetch(`https://api.example/v1/admin/leaderboard/${playerId}`,{method:'DELETE',headers:adminHeaders(),body:'{}'});
    await mf.dispatchFetch(`https://api.example/v1/admin/leaderboard/${playerId}/restore`,{method:'POST',headers:adminHeaders(),body:'{}'});
    await new Promise(r=>setTimeout(r,50));
    const managed=await backupDb.prepare('SELECT admin_note,verification_status,deleted_at FROM managed_leaderboard_state WHERE player_id=?').bind(playerId).first();expect(managed).toEqual({admin_note:'projected-note',verification_status:'verified',deleted_at:null});
    expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total).toBeGreaterThan(eventsBefore);
  });

  it('enforces actor/action/target/phrase/expiry and single use for permanent backup edit', async () => {
    const endpoint=`https://api.example/v1/admin/backup-leaderboard/${playerId}`;
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify({confirmation:true,best_score:26000})})).status).toBe(400);
    const ch=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'edit',target_id:playerId})}));
    const base={challenge_id:ch.data.challenge_id,confirmation:true,confirmation_phrase:ch.data.confirmation_phrase,best_score:26000};
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:{...adminHeaders(),'X-Admin-Actor':'other'},body:JSON.stringify(base)})).status).toBe(409);
    expect((await mf.dispatchFetch(endpoint,{method:'DELETE',headers:adminHeaders(),body:JSON.stringify(base)})).status).toBe(409);
    expect((await mf.dispatchFetch(endpoint+'x',{method:'PATCH',headers:adminHeaders(),body:JSON.stringify(base)})).status).toBe(409);
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify({...base,confirmation_phrase:'WRONG'})})).status).toBe(409);
    await backupDb.prepare('UPDATE backup_confirmation_challenges SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00Z',ch.data.challenge_id).run();
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify(base)})).status).toBe(409);
    const fresh=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'edit',target_id:playerId})}));const valid={challenge_id:fresh.data.challenge_id,confirmation:true,confirmation_phrase:fresh.data.confirmation_phrase,best_score:26000};
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify(valid)})).status).toBe(200);
    expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify(valid)})).status).toBe(409);
  });

  it('rejects invalid backup edits and confirms backup reorder by affected count', async () => {
    const endpoint=`https://api.example/v1/admin/backup-leaderboard/${playerId}`;const bad=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'edit',target_id:playerId})}));expect((await mf.dispatchFetch(endpoint,{method:'PATCH',headers:adminHeaders(),body:JSON.stringify({challenge_id:bad.data.challenge_id,confirmation:true,confirmation_phrase:bad.data.confirmation_phrase,best_score:-1})})).status).toBe(400);
    const order=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'reorder',target_id:'1'})}));const response=await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/reorder',{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:order.data.challenge_id,confirmation:true,confirmation_phrase:order.data.confirmation_phrase,player_ids:[playerId]})});expect(response.status).toBe(200);expect((await backupDb.prepare('SELECT manual_rank FROM managed_leaderboard_state WHERE player_id=?').bind(playerId).first<{manual_rank:number}>())?.manual_rank).toBe(1);
  });

  it('reconciles a committed backup action once without duplicating it',async()=>{const ch=await json<{challenge_id:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'clear',target_id:'global'})}));const actionId='reconcile-action-123456789',auditId='reconcile-audit-123456789';await backupDb.batch([backupDb.prepare(`INSERT INTO backup_admin_actions(id,actor,action,target_type,target_id,before_json,after_json,confirmation_challenge_id,created_at,primary_audit_id) VALUES(?,'integration-test','clear','leaderboard','global','{"active":0}','{"active":0}',?, ?,?)`).bind(actionId,ch.data.challenge_id,'2026-08-15T00:00:00Z',auditId),backupDb.prepare('UPDATE backup_confirmation_challenges SET used_at=? WHERE id=?').bind('2026-08-15T00:00:00Z',ch.data.challenge_id)]);const body=JSON.stringify({challenge_id:ch.data.challenge_id,confirmation:true,confirmation_1:true,confirmation_2:true,confirmation_phrase:'CLEAR BACKUP PERMANENTLY'});expect((await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/clear',{method:'POST',headers:adminHeaders(),body})).status).toBe(200);expect(await mainDb.prepare('SELECT id FROM admin_audit_logs WHERE id=?').bind(auditId).first()).toEqual({id:auditId});expect((await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/clear',{method:'POST',headers:adminHeaders(),body})).status).toBe(409);expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_admin_actions WHERE id=?').bind(actionId).first<{total:number}>())!.total).toBe(1);});

  it('lists, exports, deletes and restores managed backup without changing primary or raw events', async () => {
    const primaryBefore=await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first();const eventCount=(await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total;
    const list=await json<unknown[]>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard?limit=1',{headers:adminHeaders()}));expect(list.data).toHaveLength(1);
    const csv=await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/export.csv',{headers:adminHeaders()});expect(await csv.text()).toContain('latest_action_type');
    for(const action of ['delete','restore']){const ch=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action,target_id:playerId})}));const url=action==='delete'?`https://api.example/v1/admin/backup-leaderboard/${playerId}`:`https://api.example/v1/admin/backup-leaderboard/${playerId}/restore`;expect((await mf.dispatchFetch(url,{method:action==='delete'?'DELETE':'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation:true,confirmation_phrase:ch.data.confirmation_phrase})})).status).toBe(200);}
    expect(await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first()).toEqual(primaryBefore);expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total).toBe(eventCount);
    const history=await backupDb.prepare('SELECT before_json,after_json,permanent_no_undo FROM backup_admin_actions ORDER BY created_at DESC LIMIT 1').first<{before_json:string;after_json:string;permanent_no_undo:number}>();expect(history?.permanent_no_undo).toBe(1);expect(JSON.parse(history!.before_json)).toBeTruthy();expect(JSON.parse(history!.after_json)).toBeTruthy();
  });

  it('restores primary exactly from managed state and creates a pre-replace safety snapshot', async () => {
    const extra='extra-player-123456789012345';
    await mainDb.batch([mainDb.prepare(`INSERT INTO players(id,display_name,normalized_name,password_hash,password_salt,password_iterations,created_at,updated_at) VALUES(?,'Extra','EXTRA','h','s',100000,?,?)`).bind(extra,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),mainDb.prepare(`INSERT INTO leaderboard_entries(player_id,best_score,achieved_at,updated_at,source_platform,device_type,verification_status) VALUES(?,5,?,?,'web','desktop','unverified')`).bind(extra,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')]);
    await backupDb.prepare(`UPDATE managed_leaderboard_state SET best_score=33333,admin_note='managed exact',verification_status='flagged',manual_rank=9,deleted_at='2026-06-01T00:00:00Z',achieved_at='2026-05-01T00:00:00Z',updated_at='2026-05-02T00:00:00Z' WHERE player_id=?`).bind(playerId).run();
    const events=(await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total;
    const ch=await json<{challenge_id:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backups/restore-leaderboard/challenge',{method:'POST',headers:adminHeaders(),body:'{}'}));
    const response=await mf.dispatchFetch('https://api.example/v1/admin/backups/restore-leaderboard',{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'RESTORE PRIMARY FROM BACKUP'})});const result=await json<{safety_snapshot_id:string}>(response);expect(response.status).toBe(200);
    expect(await mainDb.prepare('SELECT player_id FROM leaderboard_entries WHERE player_id=?').bind(extra).first()).toBeNull();
    expect(await mainDb.prepare('SELECT best_score,admin_note,verification_status,manual_rank,deleted_at,achieved_at,updated_at FROM leaderboard_entries WHERE player_id=?').bind(playerId).first()).toEqual({best_score:33333,admin_note:'managed exact',verification_status:'flagged',manual_rank:9,deleted_at:'2026-06-01T00:00:00Z',achieved_at:'2026-05-01T00:00:00Z',updated_at:'2026-05-02T00:00:00Z'});
    expect(await mainDb.prepare('SELECT trigger_type,source_action_id FROM primary_leaderboard_snapshots WHERE id=?').bind(result.data.safety_snapshot_id).first()).toEqual({trigger_type:'pre_replace',source_action_id:'managed_backup'});
    expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total).toBe(events);
  });

  it('rejects invalid managed restore source without changing primary', async () => {
    const before=await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first();await backupDb.prepare("UPDATE managed_leaderboard_state SET source_platform='invalid' WHERE player_id=?").bind(playerId).run();
    const ch=await json<{challenge_id:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backups/restore-leaderboard/challenge',{method:'POST',headers:adminHeaders(),body:'{}'}));const response=await mf.dispatchFetch('https://api.example/v1/admin/backups/restore-leaderboard',{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'RESTORE PRIMARY FROM BACKUP'})});expect(response.status).toBe(409);expect(await mainDb.prepare('SELECT * FROM leaderboard_entries WHERE player_id=?').bind(playerId).first()).toEqual(before);await backupDb.prepare("UPDATE managed_leaderboard_state SET source_platform='web' WHERE player_id=?").bind(playerId).run();
  });

  it('permanently clears only managed backup state with two exact confirmations and reconciled audits', async () => {
    const primary=await mainDb.prepare('SELECT * FROM leaderboard_entries').all();const players=(await mainDb.prepare('SELECT COUNT(*) total FROM players').first<{total:number}>())!.total;const snapshots=(await mainDb.prepare('SELECT COUNT(*) total FROM primary_leaderboard_snapshots').first<{total:number}>())!.total;const events=(await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total;const audits=(await mainDb.prepare('SELECT COUNT(*) total FROM admin_audit_logs').first<{total:number}>())!.total;
    const ch=await json<{challenge_id:string;confirmation_phrase:string}>(await mf.dispatchFetch('https://api.example/v1/admin/backup-leaderboard/challenges',{method:'POST',headers:adminHeaders(),body:JSON.stringify({action:'clear',target_id:'global'})}));
    const url='https://api.example/v1/admin/backup-leaderboard/clear';expect((await mf.dispatchFetch(url,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation:true,confirmation_1:true,confirmation_phrase:ch.data.confirmation_phrase})})).status).toBe(400);expect((await mf.dispatchFetch(url,{method:'POST',headers:adminHeaders(),body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation:true,confirmation_1:true,confirmation_2:true,confirmation_phrase:'wrong'})})).status).toBe(400);
    const body={challenge_id:ch.data.challenge_id,confirmation:true,confirmation_1:true,confirmation_2:true,confirmation_phrase:'CLEAR BACKUP PERMANENTLY'};const good=await mf.dispatchFetch(url,{method:'POST',headers:adminHeaders(),body:JSON.stringify(body)});expect(good.status).toBe(200);
    expect((await backupDb.prepare('SELECT COUNT(*) total FROM managed_leaderboard_state WHERE deleted_at IS NULL').first<{total:number}>())!.total).toBe(0);expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_events').first<{total:number}>())!.total).toBe(events);expect((await mainDb.prepare('SELECT COUNT(*) total FROM players').first<{total:number}>())!.total).toBe(players);expect((await mainDb.prepare('SELECT COUNT(*) total FROM primary_leaderboard_snapshots').first<{total:number}>())!.total).toBe(snapshots);expect((await mainDb.prepare('SELECT * FROM leaderboard_entries').all()).results).toEqual(primary.results);expect((await mainDb.prepare('SELECT COUNT(*) total FROM admin_audit_logs').first<{total:number}>())!.total).toBe(audits+1);
    expect(await backupDb.prepare(`SELECT permanent_no_undo,primary_audit_synced_at FROM backup_admin_actions WHERE confirmation_challenge_id=?`).bind(ch.data.challenge_id).first()).toMatchObject({permanent_no_undo:1,primary_audit_synced_at:expect.any(String)});
    const retry=await mf.dispatchFetch(url,{method:'POST',headers:adminHeaders(),body:JSON.stringify(body)});expect(retry.status).toBe(409);expect((await backupDb.prepare('SELECT COUNT(*) total FROM backup_admin_actions WHERE confirmation_challenge_id=?').bind(ch.data.challenge_id).first<{total:number}>())!.total).toBe(1);
  });

  it('purges managed backup state when a player permanently deletes the account', async () => {
    const password = 'privacy-test-password';
    const register = await mf.dispatchFetch('https://api.example/v1/accounts/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.77',
      },
      body: JSON.stringify({
        name: 'Privacy1',
        password,
        initial_score: 4321,
        initial_level: 2,
        ...playerMeta,
        installation_id: 'privacy_delete_installation_123456',
      }),
    });
    expect(register.status).toBe(201);

    const created = await json<{
      player: { id: string };
      session: { token: string };
    }>(register);
    const privacyPlayerId = created.data.player.id;
    const privacyToken = created.data.session.token;

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      await backupDb.prepare(
        'SELECT player_id FROM managed_leaderboard_state WHERE player_id = ?',
      ).bind(privacyPlayerId).first(),
    ).toEqual({ player_id: privacyPlayerId });

    const deletion = await mf.dispatchFetch('https://api.example/v1/account', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + privacyToken,
      },
      body: JSON.stringify({ password }),
    });
    expect(deletion.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      await mainDb.prepare('SELECT id FROM players WHERE id = ?')
        .bind(privacyPlayerId).first(),
    ).toBeNull();
    expect(
      await backupDb.prepare(
        'SELECT player_id FROM managed_leaderboard_state WHERE player_id = ?',
      ).bind(privacyPlayerId).first(),
    ).toBeNull();
    expect(
      (await backupDb.prepare(
        `SELECT COUNT(*) AS total
         FROM backup_entity_snapshots
         WHERE subject_player_id = ?`,
      ).bind(privacyPlayerId).first<{ total: number }>())?.total,
    ).toBe(0);
    expect(
      (await backupDb.prepare(
        `SELECT COUNT(*) AS total
         FROM backup_events
         WHERE subject_player_id = ? AND payload_json IS NOT NULL`,
      ).bind(privacyPlayerId).first<{ total: number }>())?.total,
    ).toBe(0);
    expect(
      await backupDb.prepare(
        'SELECT player_id FROM backup_privacy_deletions WHERE player_id = ?',
      ).bind(privacyPlayerId).first(),
    ).toEqual({ player_id: privacyPlayerId });
  });


  it('reserves unique device leaderboard names and silently restores sessions', async () => {
    const availability = async (name: string) => {
      const response = await mf.dispatchFetch(
        `https://api.example/v1/device-players/name-availability?name=${encodeURIComponent(name)}`,
        { headers: { 'CF-Connecting-IP': '203.0.113.88' } },
      );
      expect(response.status).toBe(200);
      return json<{ available: boolean; display_name: string }>(response);
    };

    const registerDevice = async (installationId: string, name: string, score: number) => {
      return mf.dispatchFetch('https://api.example/v1/device-players/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.88' },
        body: JSON.stringify({
          ...playerMeta,
          installation_id: installationId,
          name,
          initial_score: score,
          initial_level: 2,
        }),
      });
    };

    expect((await availability('JONG')).data).toEqual({
      available: true,
      display_name: 'JONG',
    });

    const firstInstallation = 'device_installation_first_123456';
    const firstResponse = await registerDevice(firstInstallation, 'JONG', 31000);
    expect(firstResponse.status).toBe(201);
    const first = await json<{
      player: { id: string; display_name: string };
      session: { token: string };
      device_credentials: { player_id: string; credential: string };
      initial_score: { improved: boolean };
    }>(firstResponse);

    expect(first.data.player.display_name).toBe('JONG');
    expect(first.data.device_credentials.credential.length).toBeGreaterThanOrEqual(10);
    expect(first.data.initial_score.improved).toBe(true);
    expect((await availability(' jong ')).data.available).toBe(false);

    const duplicate = await registerDevice(
      'device_installation_duplicate_123',
      'jong',
      32000,
    );
    expect(duplicate.status).toBe(409);
    expect((await json<never>(duplicate)).error?.code).toBe('name_unavailable');

    expect(
      await mainDb.prepare(
        'SELECT display_name, normalized_name FROM players WHERE id = ?',
      ).bind(first.data.player.id).first(),
    ).toEqual({ display_name: 'JONG', normalized_name: 'JONG' });

    const restored = await mf.dispatchFetch('https://api.example/v1/device-players/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.88' },
      body: JSON.stringify({
        player_id: first.data.device_credentials.player_id,
        credential: first.data.device_credentials.credential,
        installation_id: firstInstallation,
      }),
    });
    expect(restored.status).toBe(200);
    expect((await json<{ session: { token: string } }>(restored)).data.session.token).toBeTruthy();

    const secondInstallation = 'device_installation_second_12345';
    const secondResponse = await registerDevice(secondInstallation, 'JANE', 32000);
    expect(secondResponse.status).toBe(201);
    const second = await json<{
      device_credentials: { player_id: string; credential: string };
    }>(secondResponse);

    const wrongInstallation = await mf.dispatchFetch('https://api.example/v1/device-players/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.88' },
      body: JSON.stringify({
        player_id: first.data.device_credentials.player_id,
        credential: first.data.device_credentials.credential,
        installation_id: secondInstallation,
      }),
    });
    expect(wrongInstallation.status).toBe(401);
    expect(second.data.device_credentials.player_id).not.toBe(first.data.device_credentials.player_id);
  });

});
