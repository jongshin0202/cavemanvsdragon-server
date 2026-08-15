# Client integration contract

Do not remove the current Supabase path until the development Worker, backup replication, and both web/Android smoke suites pass.

## Account and score flow

1. Keep current client-side validation and mirror the server rules: trim/collapse whitespace, require 1–10 letters/numbers/spaces, reject profanity.
2. When the first score qualifies for local or global display and no player account exists, request name and password; recovery email is optional.
3. Call `POST /v1/accounts/register` with the first score in the same request.
4. Store only the returned player ID, display name, referral code, and opaque session token. The first valid name remains the default local name.
5. On later completed games, write local history immediately and call `POST /v1/scores` automatically.
6. If the session expires, request password login; do not silently create a second account.
7. Show one global row per player. The API has already enforced highest score only.
8. Preserve the existing local top-20 leaderboard as device-only history. Clearing local history must never call the global-clear endpoint.

## Installation and platform metadata

Generate a random installation UUID once and store it locally. It is not a device fingerprint.

Send:

- `source_platform`: `android`, `ios`, or `web`.
- `web_source`: `desktop_web`, `mobile_web`, `pwa`, `embedded`, or `unknown` for Web.
- `device_type`: `phone`, `tablet`, `desktop`, `tv`, `handheld`, or `unknown`.
- declared model, OS name/version, app version, and current controls.

Do not collect IP, GPS, IMEI, serial number, MAC, advertising ID, contacts, email/phone in analytics, or a derived fingerprint.

The Worker CORS allowlist includes Capacitor's packaged-app origins
(`https://localhost` for Android and `capacitor://localhost` for the future iOS
client). Do not replace these with `*`, especially once player Authorization
headers are enabled.

## Telemetry lifecycle

Batch events locally and flush on session end/background, at a modest size threshold, or on the next launch after an offline failure. Use client-generated event IDs for idempotency.

Required timing events support installation date, launches, session/game frequency and intervals, favorite play hours, level reach/completion, controls, durations, and aggregate performance. All timestamps are ISO UTC.

## Share controls

Add share controls at:

- title screen;
- post-score screen;
- local/global leaderboard screens.

Call `POST /v1/shares` first, then use the returned personalized message, referral URL, media URL, and target. Instagram uses the native share sheet because it does not offer an equivalent general-purpose web composer. Preserve Facebook, Instagram, X, email, Telegram, and WhatsApp choices.

The `/r/:code` route records the open and selects the configured Android, iOS, or Web destination. The destination carries the referral code into first-launch telemetry.

## Controlled migration

1. Add `VITE_CVD_API_URL` without removing Supabase.
2. Read the Worker leaderboard in development and compare ordering/counts.
3. Gate Worker writes behind a development flag.
4. Validate browser, mobile browser, and packaged Android separately.
5. Run a temporary parallel-read/observability period.
6. Switch writes, then remove Supabase calls and environment keys in a later release.
