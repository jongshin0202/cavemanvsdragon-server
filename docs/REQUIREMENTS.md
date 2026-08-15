# Backend requirements ledger

This ledger is the binding scope carried forward from the Caveman Vs Dragon server discussion.

| Requirement | v0.1 implementation |
| --- | --- |
| Cloudflare Workers + D1 | Worker API with versioned primary and backup D1 schemas |
| Separate backend repository | Dedicated `cavemanvsdragon-server` repository created; implementation is ready for its first publish |
| Dev and production isolation | Separate Worker environment and primary/backup database bindings |
| Valid player names | Both client and server must reject empty/whitespace, disallowed characters, over 10 characters, and profanity |
| First name persistence | Client must save first valid name locally; server returns the canonical account identity |
| First score account prompt | Register endpoint accepts name, password, optional recovery email, and initial score in one flow |
| Later automatic submission | Authenticated score endpoint; client stores the session token securely and submits automatically |
| Cross-device login | Name + password login returns a new opaque session |
| Optional recovery email | Encrypted at rest; hash supports lookup; delivery/reset workflow is a later email-provider phase |
| Global leaderboard | Public ranked API; one row per player; highest score only |
| Source metadata | Android/iOS/Web plus Web subtype, device type/model, OS, app version, and controls |
| Server UTC timestamps | Worker normalizes all accepted timestamps to ISO UTC and adds server receive timestamps |
| Rich analytics | Install/open/session/game/level/round/control/score/share/referral events and durations |
| Privacy-minimized analytics | Random installation ID; coarse country/region; no raw IP or invasive identifiers |
| IP use | Raw IP used only in Worker memory to create rotating HMAC rate-limit identifiers |
| Admin edit | Name, score, level, timestamp, rank, status, and notes |
| Admin reorder | Explicit drag/up/down order stored as manual ranks |
| Admin delete | Audited soft delete; player privacy deletion remains permanent |
| Admin undo | Edit/delete/reorder/clear actions are reversible where safe |
| Admin export | Authenticated CSV export |
| Admin analytics | Counts, devices/platforms, levels, controls, favorite UTC hours, and coarse geography |
| Clear global leaderboard | Dedicated button plus two dialogs and server-side two-confirm challenge |
| Clear only main database | Primary soft-delete only; no backup outbox event and no backup D1 write |
| Backup/recovery | D1 Time Travel plus redundant backup event/snapshot D1, background replication, retries, status, and restore |
| Preserve raw backup | Primary clear never reaches backup; restore reads backup without modifying it |
| Post-restore continuity | Subsequent normal mutations resume primary + backup replication |
| Sharing | Facebook, Instagram/native, X, email, Telegram, and WhatsApp metadata/routes |
| Personalized sharing | Player name/score message, media URL, referral URL, title/score/leaderboard contexts |
| App-store routing | Referral router selects Android, iOS, or web destination |
| Referral attribution | Codes, share events, referral opens, install/event attribution |
| Future Private Leaderboards | Tables and disabled flag reserved; no prematurely public APIs |

## Explicit exclusions

Analytics must not store raw IP addresses, GPS coordinates, IMEI, device serial numbers, MAC addresses, advertising IDs, contacts, email, phone, or derived aggressive fingerprints. Recovery email is account data, not analytics data, and is encrypted separately.

The v0.1 server does not claim client migration, production deployment, email delivery, verified anti-cheat scoring, or enabled Private Leaderboards. Those remain gated rollout steps.
