# API v1

All JSON responses use `{ "ok": true, "data": ..., "server_time": "...Z" }`. Errors use `{ "ok": false, "error": { "code": "...", "message": "..." }, "request_id": "..." }`.

Player authentication uses `Authorization: Bearer <opaque-session-token>`. Admin authentication uses `Authorization: Bearer <ADMIN_API_TOKEN>` and should additionally be protected by Cloudflare Access in production.

## Public and player routes

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | None | Health/version check |
| `GET` | `/v1/config` | None | Policy and feature flags |
| `GET` | `/v1/leaderboard` | None | Ranked active global leaderboard |
| `POST` | `/v1/accounts/register` | None | Account + optional initial score |
| `POST` | `/v1/accounts/login` | None | Cross-device login |
| `POST` | `/v1/leaderboard-profiles/claim` | None | Alias for account registration used by the game flow |
| `POST` | `/v1/leaderboard-profiles/login` | None | Alias for cross-device login |
| `POST` | `/v1/leaderboard-profiles/upgrade` | Legacy session or device credential | Convert an old device-only name in place |
| `POST` | `/v1/leaderboard-profiles/session` | Saved device credential | Refresh an expired bearer session without asking for the password |
| `POST` | `/v1/leaderboard-profiles/recovery-question` | None | Return a configured personal recovery question |
| `POST` | `/v1/leaderboard-profiles/recover-with-question` | Correct recovery answer | Connect the requesting installation to the profile |
| `POST` | `/v1/accounts/logout` | Player | Revoke current session |
| `GET` | `/v1/account` | Player | Current account summary |
| `DELETE` | `/v1/account` | Player + password | Permanent privacy deletion |
| `POST` | `/v1/scores` | Player | Record attempt; update global row only if higher |
| `POST` | `/v1/analytics/events` | Optional player | Batch 1–50 strict telemetry events |
| `POST` | `/v1/shares` | Optional player | Track share and return target links/message/media |
| `GET` | `/r/:code` | None | Attribute referral open and route to app/web |

### Register with first score

```json
{
  "name": "ROCK HERO",
  "password": "a-long-player-password",
  "recovery_email": "optional@example.com",
  "recovery_question": "Where did I hide my secret stone?",
  "recovery_answer": "Behind the waterfall",
  "initial_score": 12500,
  "initial_level": 3,
  "occurred_at": "2026-08-14T00:00:00Z",
  "installation_id": "random-client-generated-id",
  "source_platform": "android",
  "device_type": "handheld",
  "device_model": "Example Model",
  "os_name": "Android",
  "os_version": "16",
  "app_version": "1.1.0",
  "control_type": "gamepad"
}
```

### Submit a later score

```json
{
  "score": 25000,
  "level": 4,
  "occurred_at": "2026-08-14T00:10:00Z",
  "installation_id": "random-client-generated-id",
  "source_platform": "web",
  "web_source": "desktop_web",
  "device_type": "desktop",
  "control_type": "keyboard",
  "app_version": "1.1.0"
}
```

The response includes `improved`. A valid attempt is retained in score history even when it does not replace the player's best global score.

### Name ownership and device persistence

`GET /v1/device-players/name-availability?name=Jong` retains `available` and now also returns
`claim_state` (`available`, `login_required`, or `legacy_upgrade_required`) plus
`requires_password`. Names are compared case-insensitively after trimming and normalizing spaces.

Registration and login accept the same platform metadata shown above. They link the
installation to the profile and return both the short-lived bearer `session` and
`device_credentials: { player_id, credential }`. Store the credential in secure APK
storage or browser storage appropriate to the client. When the bearer token expires,
send those values with `installation_id` to `/v1/leaderboard-profiles/session`; the
server returns a new bearer session without another password prompt. The server stores
only a SHA-256 hash of the random device credential.

For a name created by the old `/v1/device-players/register` flow, call
`/v1/leaderboard-profiles/upgrade` with `name`, the new `password`, optional
`recovery_email`, platform metadata, and either its saved legacy `credential` or its
current bearer token. The row is upgraded in place, preserving player ID, scores,
rank, history, and referral data. A name already upgraded returns
`profile_already_claimed`; the client should use login instead.

Recovery email is optional, normalized, encrypted with AES-GCM, and never returned.
No reset/request endpoint is exposed until an authenticated email-delivery service is
configured; the field is future-ready and `recovery_email_configured` reports only a
boolean.

A personal recovery question and answer are also optional and must be supplied together.
The normalized answer is stored only as a salted PBKDF2 hash and is never returned. Name
availability exposes only `recovery_question_configured`; the question itself is returned
by the separately rate-limited recovery-question route. Correctly answering it links only
the requesting installation and returns its own revocable device credential. Verification
is limited to five attempts per 15 minutes per rate-limit identity.

### Analytics event batch

The top level supplies installation and device metadata. Each event accepts only documented fields; arbitrary properties are rejected by omission rather than being stored.

```json
{
  "installation_id": "random-client-generated-id",
  "source_platform": "web",
  "web_source": "mobile_web",
  "device_type": "phone",
  "device_model": "Browser declared model",
  "os_name": "iOS",
  "os_version": "20",
  "app_version": "1.1.0",
  "control_type": "touch",
  "referral_code": "optional-code",
  "events": [
    {
      "event_id": "client-idempotency-id",
      "event_name": "level_end",
      "session_id": "random-session-id",
      "game_id": "random-game-id",
      "occurred_at": "2026-08-14T00:10:00Z",
      "duration_ms": 45000,
      "level": 2,
      "round": 1,
      "score": 9000,
      "outcome": "completed"
    }
  ]
}
```

Allowed events: `install`, `app_open`, `session_start`, `session_end`, `game_start`, `game_end`, `level_start`, `level_end`, `round_start`, `round_end`, `control_used`, `score_submit`, `leaderboard_view`, `share`, `referral_open`, and `account_login`.

## Admin routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/admin` | Admin dashboard |
| `GET` | `/v1/admin/leaderboard` | Full/soft-deleted leaderboard data |
| `PATCH` | `/v1/admin/leaderboard/:playerId` | Edit fields |
| `DELETE` | `/v1/admin/leaderboard/:playerId` | Soft delete |
| `POST` | `/v1/admin/leaderboard/reorder` | Save explicit order |
| `GET` | `/v1/admin/leaderboard/export.csv` | CSV export |
| `POST` | `/v1/admin/leaderboard/clear/challenge` | First server clear confirmation |
| `POST` | `/v1/admin/leaderboard/clear` | Double-confirmed primary-only clear |
| `POST` | `/v1/admin/audit/:auditId/undo` | Undo supported action |
| `GET` | `/v1/admin/audit` | Audit history |
| `GET` | `/v1/admin/analytics/summary` | Analytics summary |
| `GET` | `/v1/admin/backups/status` | Redundancy health |
| `POST` | `/v1/admin/backups/restore-leaderboard/challenge` | First restore confirmation |
| `POST` | `/v1/admin/backups/restore-leaderboard` | Rebuild primary from backup |

The clear endpoint requires a live actor-bound challenge, both boolean confirmations, and exact phrase `CLEAR PRIMARY ONLY`. The restore endpoint similarly requires `RESTORE PRIMARY FROM BACKUP`. The dashboard presents two separate browser confirmation dialogs for each action.
# Leaderboard recovery administration

Every route below requires the existing bearer administrator token and actor
header. Errors use the standard structured error envelope.

| Endpoint | Handler | Validation / safety | Audit |
|---|---|---|---|
| `POST /v1/admin/leaderboard/:playerId/restore` | `restorePrimaryEntry` | Existing deleted row; parameterized ID lookup | Primary audit plus complete backup outbox state |
| `GET /v1/admin/snapshots` | `listSnapshots` | Limit 1–100 | Read-only |
| `GET /v1/admin/snapshots/:snapshotId` | `viewSnapshot` | ID, limit 1–500, offset | Read-only |
| `POST /v1/admin/snapshots/:snapshotId/restore/challenge` | `createSnapshotRestoreChallenge` | Existing selected/latest-pre-clear source | Challenge record |
| `POST /v1/admin/snapshots/:snapshotId/restore` | `restoreSnapshot` | Two booleans, bound single-use challenge, exact source phrase, complete source count | Primary restore audit with source and safety snapshot IDs |
| `GET /v1/admin/backup-leaderboard` | `listBackupState` | Limit 1–500; active and deleted | Read-only |
| `GET /v1/admin/backup-leaderboard/export.csv` | `exportBackupCsv` | Maximum 500 managed rows | Read-only |
| `GET /v1/admin/backup-leaderboard/history` | `backupHistory` | Limit 1–200 | Read-only append-only history |
| `POST /v1/admin/backup-leaderboard/challenges` | `createBackupChallenge` | Known action, validated target, five-minute actor binding | Challenge record |
| `PATCH/DELETE /v1/admin/backup-leaderboard/:playerId` | `mutateBackup` | Strict row fields plus exact bound confirmation | Permanent backup action |
| `POST /v1/admin/backup-leaderboard/:playerId/restore` | `mutateBackup` | Deleted target plus exact bound confirmation | Permanent backup action |
| `POST /v1/admin/backup-leaderboard/reorder` | `reorderBackup` | All active IDs exactly once, max 500, exact count-bound confirmation | Permanent before/after order action |
| `POST /v1/admin/backup-leaderboard/clear` | `clearBackup` | Two stages and `CLEAR BACKUP PERMANENTLY` | Permanent backup action plus reconciled primary audit |
| `POST /v1/admin/backups/restore-leaderboard` | `restorePrimaryFromManagedBackup` | Two confirmations, complete managed-source validation, staging | Primary restore audit with safety snapshot ID |
