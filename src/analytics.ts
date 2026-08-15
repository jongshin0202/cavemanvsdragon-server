import { optionalPlayer } from './auth';
import { newId, readJson, requestGeography, safeIsoUtc, safeOptionalInteger, utcNow } from './http';
import { enforceRateLimit } from './rate-limit';
import { HttpError, type Env } from './types';
import { parsePlatformMeta, validateInstallationId, validateReferralCode } from './validation';

const EVENT_NAMES = new Set([
  'install', 'app_open', 'session_start', 'session_end',
  'game_start', 'game_end', 'level_start', 'level_end',
  'round_start', 'round_end', 'control_used', 'score_submit',
  'leaderboard_view', 'share', 'referral_open', 'account_login',
]);

const OUTCOMES = new Set(['started', 'completed', 'won', 'lost', 'quit', 'backgrounded', 'unknown']);

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new HttpError(400, 'invalid_field', `${field} is invalid.`, { field });
  }
  return value;
}

function optionalOutcome(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !OUTCOMES.has(value)) {
    throw new HttpError(400, 'invalid_field', 'outcome is invalid.', { field: 'outcome' });
  }
  return value;
}

export async function recordAnalytics(request: Request, env: Env): Promise<{ accepted: number }> {
  await enforceRateLimit(request, env, { routeKey: 'analytics', limit: 120, windowSeconds: 60 });
  const body = await readJson<Record<string, unknown>>(request);
  const installationId = validateInstallationId(body.installation_id);
  const meta = parsePlatformMeta({ ...body, installation_id: installationId });
  const referralCode = validateReferralCode(body.referral_code);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
    throw new HttpError(400, 'invalid_events', 'events must contain 1 to 50 analytics events.');
  }
  const auth = await optionalPlayer(request, env);
  const geography = requestGeography(request);
  const receivedAt = utcNow();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO installations
        (id, player_id, source_platform, web_source, device_type, device_model, os_name, os_version,
         app_version, first_seen_at, last_seen_at, country_code, region_code, referral_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         player_id = COALESCE(excluded.player_id, installations.player_id),
         source_platform = excluded.source_platform,
         web_source = excluded.web_source,
         device_type = excluded.device_type,
         device_model = excluded.device_model,
         os_name = excluded.os_name,
         os_version = excluded.os_version,
         app_version = excluded.app_version,
         last_seen_at = excluded.last_seen_at,
         country_code = excluded.country_code,
         region_code = excluded.region_code,
         referral_code = COALESCE(installations.referral_code, excluded.referral_code)`,
    ).bind(
      installationId, auth?.player_id ?? null, meta.source_platform, meta.web_source, meta.device_type,
      meta.device_model, meta.os_name, meta.os_version, meta.app_version, receivedAt, receivedAt,
      geography.country_code, geography.region_code, referralCode,
    ),
  ];
  for (const rawEvent of body.events) {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      throw new HttpError(400, 'invalid_event', 'Each analytics event must be an object.');
    }
    const event = rawEvent as Record<string, unknown>;
    if (typeof event.event_name !== 'string' || !EVENT_NAMES.has(event.event_name)) {
      throw new HttpError(400, 'invalid_event_name', 'Analytics event_name is invalid.');
    }
    const duration = safeOptionalInteger(event.duration_ms, 0, 86_400_000, 'duration_ms');
    const level = safeOptionalInteger(event.level, 1, 10_000, 'level');
    const round = safeOptionalInteger(event.round, 1, 1_000_000, 'round');
    const score = safeOptionalInteger(event.score, 0, 99_999_999, 'score');
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO analytics_events
        (id, event_name, installation_id, player_id, session_id, game_id, occurred_at, received_at,
         duration_ms, level, round, score, outcome, control_type, source_platform, web_source,
         device_type, device_model, os_name, os_version, app_version, country_code, region_code, referral_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      optionalId(event.event_id, 'event_id') ?? newId(), event.event_name, installationId,
      auth?.player_id ?? null, optionalId(event.session_id, 'session_id'), optionalId(event.game_id, 'game_id'),
      safeIsoUtc(event.occurred_at, 'occurred_at'), receivedAt, duration, level, round, score,
      optionalOutcome(event.outcome), meta.control_type, meta.source_platform, meta.web_source,
      meta.device_type, meta.device_model, meta.os_name, meta.os_version, meta.app_version,
      geography.country_code, geography.region_code, referralCode,
    ));
  }
  await env.DB.batch(statements);
  return { accepted: body.events.length };
}
