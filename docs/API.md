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
