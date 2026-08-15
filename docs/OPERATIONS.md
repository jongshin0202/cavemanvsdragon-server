# Operations and recovery

## Environments

Never share primary or backup databases between development and production. The intended topology is four D1 databases:

- `cavemanvsdragon-dev`
- `cavemanvsdragon-backup-dev`
- `cavemanvsdragon-production`
- `cavemanvsdragon-backup-production`

Apply primary migrations with Wrangler's migration command. Apply the backup SQL only to the matching backup binding. Record the resulting database IDs in the correct Wrangler environment.

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
