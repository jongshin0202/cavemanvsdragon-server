import { optionalPlayer } from './auth';
import { backupOutboxStatement } from './backup';
import { newId, readJson, requestGeography, safeOptionalInteger, utcNow } from './http';
import { enforceRateLimit } from './rate-limit';
import { HttpError, type Env } from './types';
import { parsePlatformMeta, validateInstallationId, validateReferralCode } from './validation';

const CHANNELS = new Set(['facebook', 'instagram', 'x', 'email', 'telegram', 'whatsapp', 'native', 'copy_link']);
const SCREENS = new Set(['title', 'score', 'leaderboard']);

function newReferralCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function valueFromSet(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new HttpError(400, 'invalid_field', `${field} is invalid.`, { field });
  }
  return value;
}

function shareTargets(message: string, url: string): Record<string, string | { mode: string }> {
  const encodedUrl = encodeURIComponent(url);
  const encodedMessage = encodeURIComponent(message);
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://x.com/intent/post?text=${encodedMessage}&url=${encodedUrl}`,
    email: `mailto:?subject=${encodeURIComponent('Caveman Vs Dragon')}&body=${encodedMessage}%0A${encodedUrl}`,
    telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedMessage}`,
    whatsapp: `https://wa.me/?text=${encodedMessage}%20${encodedUrl}`,
    instagram: { mode: 'native_share' },
  };
}

export async function createShare(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'share', limit: 30, windowSeconds: 60 });
  const body = await readJson<Record<string, unknown>>(request);
  const auth = await optionalPlayer(request, env);
  const meta = parsePlatformMeta(body);
  const channel = valueFromSet(body.channel, CHANNELS, 'channel');
  const screen = valueFromSet(body.screen, SCREENS, 'screen');
  const score = safeOptionalInteger(body.score, 0, 99_999_999, 'score');
  const installationId = body.installation_id ? validateInstallationId(body.installation_id) : null;
  let code = validateReferralCode(body.referral_code);
  if (!code && auth) {
    code = (await env.DB.prepare(
      'SELECT code FROM referral_codes WHERE player_id = ? AND disabled_at IS NULL ORDER BY created_at LIMIT 1',
    ).bind(auth.player_id).first<{ code: string }>())?.code ?? null;
  }
  const now = utcNow();
  const statements: D1PreparedStatement[] = [];
  if (!code) {
    code = newReferralCode();
    statements.push(env.DB.prepare(
      'INSERT INTO referral_codes (code, player_id, campaign, created_at) VALUES (?, ?, ?, ?)',
    ).bind(code, auth?.player_id ?? null, 'anonymous_share', now));
  } else {
    const existing = await env.DB.prepare(
      'SELECT code FROM referral_codes WHERE code = ? AND disabled_at IS NULL',
    ).bind(code).first<{ code: string }>();
    if (!existing) throw new HttpError(404, 'referral_not_found', 'Referral code was not found.');
  }
  const shareId = newId();
  const eventPayload = {
    id: shareId,
    player_id: auth?.player_id ?? null,
    installation_id: installationId,
    referral_code: code,
    channel,
    screen,
    score,
    created_at: now,
    source_platform: meta.source_platform,
    device_type: meta.device_type,
  };
  statements.push(
    env.DB.prepare(
      `INSERT INTO share_events
        (id, player_id, installation_id, referral_code, channel, screen, score, created_at, source_platform, device_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      shareId, auth?.player_id ?? null, installationId, code, channel, screen, score, now,
      meta.source_platform, meta.device_type,
    ),
    backupOutboxStatement(env.DB, {
      entity_type: 'share_event',
      entity_id: shareId,
      subject_player_id: auth?.player_id ?? null,
      payload: eventPayload,
      occurred_at: now,
    }),
  );
  await env.DB.batch(statements);
  const base = new URL(env.WEB_APP_URL);
  const shareBase = new URL(env.PUBLIC_API_URL || env.WEB_APP_URL);
  const shareUrl = `${shareBase.origin}/r/${code}?screen=${encodeURIComponent(screen)}${score === null ? '' : `&score=${score}`}`;
  const name = auth?.display_name;
  const message = score === null
    ? `${name ? `${name} invited you to` : 'Play'} Caveman Vs Dragon. Can you reach the top of the global leaderboard?`
    : `${name ?? 'I'} scored ${score.toLocaleString('en-US')} in Caveman Vs Dragon. Can you beat it?`;
  return {
    share_id: shareId,
    referral_code: code,
    channel,
    screen,
    score,
    message,
    url: shareUrl,
    media_url: `${base.origin}/og-image-v2.png`,
    targets: shareTargets(message, shareUrl),
  };
}

function referralDestination(request: Request, env: Env): { kind: 'android' | 'ios' | 'web'; url: string } {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  if (/android/.test(ua)) return { kind: 'android', url: env.ANDROID_STORE_URL || env.WEB_APP_URL };
  if (/iphone|ipad|ipod/.test(ua)) return { kind: 'ios', url: env.IOS_STORE_URL || env.WEB_APP_URL };
  return { kind: 'web', url: env.WEB_APP_URL };
}

export async function openReferral(
  request: Request,
  env: Env,
  codeValue: string,
): Promise<Response> {
  const code = validateReferralCode(codeValue);
  if (!code) throw new HttpError(404, 'referral_not_found', 'Referral code was not found.');
  const existing = await env.DB.prepare(
    'SELECT code FROM referral_codes WHERE code = ? AND disabled_at IS NULL',
  ).bind(code).first<{ code: string }>();
  if (!existing) throw new HttpError(404, 'referral_not_found', 'Referral code was not found.');
  const destination = referralDestination(request, env);
  const geography = requestGeography(request);
  await env.DB.prepare(
    `INSERT INTO referral_opens (id, referral_code, opened_at, country_code, region_code, destination)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), code, utcNow(), geography.country_code, geography.region_code, destination.kind).run();
  const url = new URL(destination.url);
  url.searchParams.set('ref', code);
  const incoming = new URL(request.url);
  const screen = incoming.searchParams.get('screen');
  const score = incoming.searchParams.get('score');
  if (screen) url.searchParams.set('screen', screen.slice(0, 20));
  if (score && /^\d{1,8}$/.test(score)) url.searchParams.set('score', score);
  return Response.redirect(url.toString(), 302);
}
