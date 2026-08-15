import { createPlayerSession, requirePlayer, revokeCurrentSession } from './auth';
import { backupOutboxStatement } from './backup';
import { encryptRecoveryEmail, hashPassword, verifyPassword } from './crypto';
import { newId, readJson, safeOptionalInteger, utcNow } from './http';
import { submitScore } from './leaderboard';
import { enforceRateLimit } from './rate-limit';
import { HttpError, type Env, type PlayerAuth } from './types';
import {
  parsePlatformMeta,
  validateDisplayName,
  validatePassword,
  validateRecoveryEmail,
} from './validation';

function passwordIterations(env: Env): number {
  const value = Number.parseInt(env.PASSWORD_ITERATIONS || '600000', 10);
  const minimum = env.ENVIRONMENT === 'test' ? 100_000 : 600_000;
  return Math.min(1_000_000, Math.max(minimum, Number.isFinite(value) ? value : 600_000));
}

function referralCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

export async function registerAccount(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'account-register', limit: 8, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const password = validatePassword(body.password);
  const recoveryEmail = validateRecoveryEmail(body.recovery_email);
  const meta = parsePlatformMeta(body);
  const initialScore = safeOptionalInteger(body.initial_score, 1, 99_999_999, 'initial_score');
  const initialLevel = safeOptionalInteger(body.initial_level, 1, 10_000, 'initial_level');
  const credentials = await hashPassword(password, passwordIterations(env));
  const encryptedEmail = recoveryEmail
    ? await encryptRecoveryEmail(recoveryEmail, env.RECOVERY_EMAIL_KEY)
    : null;
  const playerId = newId();
  const now = utcNow();
  const code = referralCode();
  const safeBackupPlayer = {
    id: playerId,
    display_name: name.display_name,
    normalized_name: name.normalized_name,
    password_hash: credentials.hash,
    password_salt: credentials.salt,
    password_iterations: credentials.iterations,
    recovery_email_ciphertext: encryptedEmail?.ciphertext ?? null,
    recovery_email_iv: encryptedEmail?.iv ?? null,
    recovery_email_hash: encryptedEmail?.hash ?? null,
    created_at: now,
    updated_at: now,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO players
          (id, display_name, normalized_name, password_hash, password_salt, password_iterations,
           recovery_email_ciphertext, recovery_email_iv, recovery_email_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        playerId, name.display_name, name.normalized_name, credentials.hash, credentials.salt,
        credentials.iterations, encryptedEmail?.ciphertext ?? null, encryptedEmail?.iv ?? null,
        encryptedEmail?.hash ?? null, now, now,
      ),
      env.DB.prepare(
        'INSERT INTO referral_codes (code, player_id, campaign, created_at) VALUES (?, ?, ?, ?)',
      ).bind(code, playerId, 'player', now),
      backupOutboxStatement(env.DB, {
        entity_type: 'player',
        entity_id: playerId,
        subject_player_id: playerId,
        payload: safeBackupPlayer,
        occurred_at: now,
      }),
      backupOutboxStatement(env.DB, {
        entity_type: 'referral_code',
        entity_id: code,
        subject_player_id: playerId,
        payload: { code, player_id: playerId, campaign: 'player', created_at: now },
        occurred_at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new HttpError(409, 'account_conflict', 'That player name or recovery email is already registered.');
    }
    throw error;
  }
  const session = await createPlayerSession(env, playerId);
  let initialScoreResult: Record<string, unknown> | null = null;
  if (initialScore !== null) {
    const auth: PlayerAuth = {
      session_id: '',
      player_id: playerId,
      display_name: name.display_name,
      normalized_name: name.normalized_name,
      password_hash: credentials.hash,
      password_salt: credentials.salt,
      password_iterations: credentials.iterations,
    };
    initialScoreResult = await submitScore(
      env,
      request,
      auth,
      { score: initialScore, level: initialLevel, occurred_at: body.occurred_at },
      meta,
    );
  }
  return {
    player: {
      id: playerId,
      display_name: name.display_name,
      recovery_email_configured: Boolean(recoveryEmail),
      referral_code: code,
      created_at: now,
    },
    session,
    initial_score: initialScoreResult,
  };
}

export async function loginAccount(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'account-login', limit: 12, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const password = validatePassword(body.password);
  const player = await env.DB.prepare(
    `SELECT id, display_name, normalized_name, password_hash, password_salt, password_iterations, created_at
     FROM players
     WHERE normalized_name = ? AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(name.normalized_name).first<PlayerAuth & { id: string; created_at: string }>();
  if (!player || !(await verifyPassword(password, player.password_hash, player.password_salt, player.password_iterations))) {
    throw new HttpError(401, 'invalid_credentials', 'Player name or password is incorrect.');
  }
  const session = await createPlayerSession(env, player.id);
  const referral = await env.DB.prepare(
    'SELECT code FROM referral_codes WHERE player_id = ? AND disabled_at IS NULL ORDER BY created_at LIMIT 1',
  ).bind(player.id).first<{ code: string }>();
  return {
    player: {
      id: player.id,
      display_name: player.display_name,
      referral_code: referral?.code ?? null,
      created_at: player.created_at,
    },
    session,
  };
}

export async function getAccount(request: Request, env: Env): Promise<Record<string, unknown>> {
  const auth = await requirePlayer(request, env);
  const row = await env.DB.prepare(
    `SELECT id, display_name, recovery_email_hash, recovery_email_verified_at, created_at, updated_at
     FROM players WHERE id = ?`,
  ).bind(auth.player_id).first<Record<string, unknown>>();
  const referral = await env.DB.prepare(
    'SELECT code FROM referral_codes WHERE player_id = ? AND disabled_at IS NULL ORDER BY created_at LIMIT 1',
  ).bind(auth.player_id).first<{ code: string }>();
  return {
    ...row,
    recovery_email_configured: Boolean(row?.recovery_email_hash),
    recovery_email_hash: undefined,
    referral_code: referral?.code ?? null,
  };
}

export async function logoutAccount(request: Request, env: Env): Promise<void> {
  await requirePlayer(request, env);
  await revokeCurrentSession(request, env);
}

export async function deleteAccountPermanently(request: Request, env: Env): Promise<{ deleted: true }> {
  const auth = await requirePlayer(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const password = validatePassword(body.password);
  if (!(await verifyPassword(password, auth.password_hash, auth.password_salt, auth.password_iterations))) {
    throw new HttpError(401, 'invalid_credentials', 'Password is incorrect.');
  }
  const now = utcNow();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM analytics_events WHERE player_id = ?').bind(auth.player_id),
    env.DB.prepare('DELETE FROM installations WHERE player_id = ?').bind(auth.player_id),
    env.DB.prepare('DELETE FROM players WHERE id = ?').bind(auth.player_id),
    backupOutboxStatement(env.DB, {
      entity_type: 'player',
      entity_id: auth.player_id,
      subject_player_id: auth.player_id,
      operation: 'privacy_delete',
      occurred_at: now,
    }),
  ]);
  return { deleted: true };
}
