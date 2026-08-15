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

describe('admin dashboard section organization', () => {
  it('renders the primary and backup sections in the required DOM order', () => {
    const headings = [
      '<h2>Authentication</h2>',
      '<h2>Primary Global Leaderboard — Primary Database</h2>',
      '<h2>Primary Snapshots</h2>',
      '<h2>Primary Operations and Recovery</h2>',
      '<h2>Primary Danger Zone</h2>',
      '<h2>Backup Global Leaderboard — Independent Backup Database</h2>',
      '<h2>Backup Danger Zone</h2>',
    ];

    const positions = headings.map((heading) => ADMIN_HTML.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('keeps each leaderboard table inside its labeled database section', () => {
    const primaryStart = ADMIN_HTML.indexOf('id="primaryLeaderboard"');
    const primaryRows = ADMIN_HTML.indexOf('id="rows"');
    const snapshotsStart = ADMIN_HTML.indexOf('id="primarySnapshots"');
    const backupStart = ADMIN_HTML.indexOf('id="backupLeaderboard"');
    const backupRows = ADMIN_HTML.indexOf('id="backupRows"');
    const backupDangerStart = ADMIN_HTML.indexOf('id="backupDanger"');

    expect(primaryStart).toBeLessThan(primaryRows);
    expect(primaryRows).toBeLessThan(snapshotsStart);
    expect(backupStart).toBeLessThan(backupRows);
    expect(backupRows).toBeLessThan(backupDangerStart);
  });
});
