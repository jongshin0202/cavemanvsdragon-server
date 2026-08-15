import { constantTimeEqual, randomToken, sha256 } from './crypto';
import { newId, utcNow } from './http';
import { HttpError, type AdminAuth, type Env, type PlayerAuth } from './types';

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export async function createPlayerSession(
  env: Env,
  playerId: string,
): Promise<{ token: string; expires_at: string }> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = utcNow();
  const ttlDays = Math.min(90, Math.max(1, Number.parseInt(env.SESSION_TTL_DAYS || '30', 10) || 30));
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO player_sessions
      (id, player_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), playerId, tokenHash, now, expiresAt, now).run();
  return { token, expires_at: expiresAt };
}

export async function requirePlayer(request: Request, env: Env): Promise<PlayerAuth> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'authentication_required', 'Player authentication is required.');
  const tokenHash = await sha256(token);
  const now = utcNow();
  const row = await env.DB.prepare(
    `SELECT
       s.id AS session_id,
       p.id AS player_id,
       p.display_name,
       p.normalized_name,
       p.password_hash,
       p.password_salt,
       p.password_iterations
     FROM player_sessions s
     JOIN players p ON p.id = s.player_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
       AND p.deleted_at IS NULL
     LIMIT 1`,
  ).bind(tokenHash, now).first<PlayerAuth>();
  if (!row) throw new HttpError(401, 'invalid_session', 'Player session is invalid or expired.');
  await env.DB.prepare('UPDATE player_sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now, row.session_id).run();
  return row;
}

export async function optionalPlayer(request: Request, env: Env): Promise<PlayerAuth | null> {
  if (!bearerToken(request)) return null;
  try {
    return await requirePlayer(request, env);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}

export async function revokeCurrentSession(request: Request, env: Env): Promise<void> {
  const token = bearerToken(request);
  if (!token) return;
  const tokenHash = await sha256(token);
  await env.DB.prepare(
    'UPDATE player_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
  ).bind(utcNow(), tokenHash).run();
}

export async function requireAdmin(request: Request, env: Env): Promise<AdminAuth> {
  const supplied = bearerToken(request);
  const expected = env.ADMIN_API_TOKEN;
  if (!supplied || !expected || !constantTimeEqual(await sha256(supplied), await sha256(expected))) {
    throw new HttpError(401, 'admin_authentication_required', 'Administrator authentication is required.');
  }
  const accessActor = request.headers.get('cf-access-authenticated-user-email');
  const requestedActor = request.headers.get('x-admin-actor');
  const rawActor = accessActor || requestedActor || 'admin';
  const actor = rawActor.trim().slice(0, 120) || 'admin';
  return { actor };
}
