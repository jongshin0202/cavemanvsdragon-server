import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_HTML } from '../src/admin-ui';

describe('global leaderboard clear safety', () => {
  it('renders two distinct admin confirmations', () => {
    expect(ADMIN_HTML).toContain('CONFIRMATION 1 OF 2');
    expect(ADMIN_HTML).toContain('CONFIRMATION 2 OF 2 — FINAL');
    expect(ADMIN_HTML).toContain("confirmation_1:true,confirmation_2:true");
    expect(ADMIN_HTML).toContain("confirmation_phrase:'CLEAR PRIMARY ONLY'");
  });

  it('does not enqueue or mutate backup storage in the primary clear handler', () => {
    const source = readFileSync(new URL('../src/admin.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function clearPrimaryLeaderboard');
    const end = source.indexOf('interface BackupScorePayload', start);
    const handler = source.slice(start, end);
    expect(handler).toContain('Deliberately no backup_outbox row');
    expect(handler).not.toContain('backupOutboxStatement(');
    expect(handler).not.toContain('env.BACKUP_DB');
    expect(handler).toContain("confirmation_phrase !== 'CLEAR PRIMARY ONLY'");
  });
});
