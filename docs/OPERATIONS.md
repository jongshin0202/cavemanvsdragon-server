# Operations and recovery

## Environments

Never share primary or backup databases between development and production. The intended topology is four D1 databases:

- `cavemanvsdragon-dev`
- `cavemanvsdragon-backup-dev`
- `cavemanvsdragon-production`
- `cavemanvsdragon-backup-production`

Apply primary migrations with Wrangler's migration command. Apply the backup SQL only to the matching backup binding. Record the resulting database IDs in the correct Wrangler environment.

Keep `PASSWORD_ITERATIONS` set to `100000` in every Worker environment. Account registration clamps the PBKDF2 work factor to exactly 100,000 because Cloudflare Workers Web Crypto rejects larger values, while the primary D1 schema rejects stored values below 100,000.

## Backup layers

1. **D1 Time Travel** is automatic. Cloudflare documents minute-level restore within 30 days on Workers Paid and 7 days on Workers Free. A restore overwrites a database in place, cancels in-flight queries, and returns a prior bookmark that can undo the restore.
2. **Redundant backup D1** receives normal mutation events and latest entity snapshots from `backup_outbox`.
3. **Immediate replication** is attempted after mutating API responses through `waitUntil`.
4. **Retry replication** runs every five minutes; failed rows remain in primary `backup_outbox` with an attempt counter and last error.
5. **Primary-only clear exception** emits no backup event and never touches `BACKUP_DB`.

Cloudflare reference: [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

## Global-clear procedure

1. Open `/admin` through Cloudflare Access.
2. Review and export the leaderboard.
3. Review backup status; pending should be zero.
4. Press **Clear Global Leaderboard**.
5. Accept confirmation 1, which explicitly says primary only.
6. Accept confirmation 2, which explicitly says final and backup unchanged.
7. Verify the response states `backup_modified: false`.
8. Verify the public leaderboard is empty.
9. Recheck backup event/snapshot counts; they must be unchanged.

The operation is an audited bulk soft-delete in primary D1. It does not physically purge leaderboard rows and can be undone from the same dashboard. That behavior preserves the earlier requirement that admin deletion be soft while player privacy deletion is permanent.

## Application-level leaderboard restore

1. Review backup status and primary audit history.
2. Press **Restore primary from backup**.
3. Accept both restore confirmations.
4. The Worker reads redundant `score_submission` snapshots, selects each player's all-time highest score, and merges it into primary D1.
5. The restore does not change the backup.
6. Verify ranking, row count, highest-score-only semantics, and representative names/platforms.
7. Submit a controlled post-restore test score and verify a new backup event appears. This confirms later changes again apply to primary and backup.

## D1 Time Travel emergency restore

Time Travel is destructive. Before using it:

1. Stop or gate writes.
2. Record the current bookmark for both primary and backup.
3. Export the affected database when possible.
4. Retrieve the intended timestamp/bookmark.
5. Have a second administrator review database name, environment, and bookmark.
6. Run the Time Travel restore on primary only unless the backup itself is independently corrupt.
7. Keep the returned prior bookmark so the restore can be undone.
8. Apply any missing migrations, verify counts and API health, resume writes, and check outbox replication.

Do not use the global-clear dashboard action as a substitute for a schema/database recovery.

## Privacy deletion

Player-requested permanent deletion removes account-linked primary data. A `privacy_delete` backup event then:

- nulls historical backup payloads for that player;
- deletes latest backup snapshots for that player;
- writes a non-PII privacy tombstone so later replay will not resurrect the account.

This is intentionally different from an admin leaderboard soft delete or global clear.

## Deployment smoke checklist

- `/health` returns the expected environment and version.
- Both schemas report version `1`.
- Name/password registration succeeds and duplicate name returns `409`.
- Login works on a second browser/device.
- Lower score leaves the best unchanged; higher score replaces it.
- Public ranking is one row per player.
- Analytics event accepts declared device metadata and contains no raw IP field/value.
- Admin edit, reorder, soft delete, undo, and CSV export work.
- Normal mutation reaches backup.
- Double-confirm clear empties primary and leaves backup counts unchanged.
- Undo or restore repopulates primary.
- A post-restore score again reaches backup.
- Referral route selects Web/Android/iOS as configured.

## Scheduled maintenance

The five-minute scheduled handler flushes up to 500 pending backup mutations, removes expired rate-limit windows, removes old revoked/expired sessions, and cleans used/expired admin confirmation challenges.
# Leaderboard snapshots and managed backup operations

## Lifecycle and boundaries

Primary snapshot tables retain immutable pre-clear and pre-replace points. Primary clear inserts the complete snapshot before soft deletion in one batch. Snapshot restore validates entry count; managed-backup restore validates and stages its cross-binding source. Both then create a safety snapshot and exactly replace primary in one atomic batch. Deleted source rows remain deleted.

Managed backup state is independently administrable. Raw `backup_events` remains append-only forensic history except privacy redaction, and `backup_admin_actions` permanently records direct administration. D1 Time Travel is infrastructure recovery, not application Undo.

## Confirmations and recovery

Primary clear uses `CLEAR PRIMARY ONLY`, backup-based primary restore uses `RESTORE PRIMARY FROM BACKUP`, and selected snapshots use `RESTORE SNAPSHOT <snapshot-id>`. Backup row challenges last five minutes and are single-use/bound to actor, action, and target; phrases are `PERMANENTLY <ACTION> <player-id>`. Backup clear requires two confirmations and exactly **`CLEAR BACKUP PERMANENTLY`**. There is no backup application Undo.

Recover a clear with **Primary Snapshots → Restore latest pre-clear**. For point-in-time recovery, view and select a snapshot. For backup recovery, inspect managed state and choose Restore primary from backup. Save the returned safety snapshot ID; restoring it reverses an unwanted replacement. Clearing primary leaves backup recovery intact. Clearing managed backup leaves primary, accounts, snapshots, audit, and events intact, but managed-backup restoration will preserve those rows as deleted.

## Migration and rollout

```sh
npm run db:migrate:local
npm run backup:migrate:local
# Approved remote rollout only:
npx wrangler d1 migrations apply DB --env production --remote
npx wrangler d1 execute BACKUP_DB --env production --remote --file=backup-migrations/0002_managed_leaderboard.sql
```

Migration 0002 prefers complete `leaderboard_entry` snapshots and preserves deletion state. Old score-submission-only history cannot reconstruct display names, notes, manual order, verification decisions, later edits, or deletion state; its best-score fallback is necessarily lossy for those fields and must be reviewed/backfilled before exact restore. Existing complete development state, including CAVE TEST, remains recoverable.

## Post-deployment smoke test

1. Confirm both schema versions are 2; list snapshots and managed backup state.
2. Create/update a disposable score, flush the outbox, and verify one raw event plus a complete managed row.
3. Soft-delete and row-restore it; verify metadata and managed state.
4. In a disposable environment, clear primary; verify the complete pre-clear snapshot and unchanged backup, then restore it exactly.
5. Reject a wrong backup phrase, accept a fresh exact phrase once, reject reuse, and verify one append-only admin action.
6. In a disposable environment clear managed backup; verify primary, snapshots, accounts, and raw events are unchanged.
7. Restore the safety snapshot and compare deletion state, order, values, notes, timestamps, metadata, and verification status.

## Cross-database backup-clear reconciliation

D1 bindings cannot share a transaction, and the application does **not** claim
cross-database atomicity. Backup clear therefore uses this explicit order:

1. Validate the actor/action/target-bound challenge and exact phrase.
2. In one `BACKUP_DB` batch, deactivate managed rows, append the uniquely
   challenge-bound `backup_admin_actions` row, reserve a stable primary audit
   ID, and consume the challenge.
3. Insert the corresponding primary audit with `INSERT OR IGNORE` using that
   stable ID.
4. Mark the backup action's `primary_audit_synced_at` only after step 3 works.

If step 2 fails, nothing is committed and the request fails. If step 3 or 4
fails, the permanent backup change is already committed, the API returns a
structured `503 backup_mutation_committed_audit_pending` rather than reporting
success, and the same request may be retried solely to reconcile the reserved
audit. The unique challenge constraint prevents a duplicate permanent action;
the stable audit ID makes primary insertion idempotent. Once reconciliation is
marked complete, challenge reuse is rejected normally. Operators should alert
on the pending error and retry before performing another backup mutation.
