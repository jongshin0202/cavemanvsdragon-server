import { createPlayerSession, optionalPlayer, requirePlayer, revokeCurrentSession } from './auth';
import { backupOutboxStatement } from './backup';
import { constantTimeEqual, encryptRecoveryEmail, hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import { cleanText, newId, readJson, requestGeography, safeInteger, safeIsoUtc, safeOptionalInteger, utcNow } from './http';
import { submitScore } from './leaderboard';
import { enforceRateLimit } from './rate-limit';
import { HttpError, type Env, type PlayerAuth } from './types';
import {
  parsePlatformMeta,
  validateDisplayName,
  validateInstallationId,
  validatePassword,
  validateRecoveryEmail,
} from './validation';

export function passwordIterations(env: Pick<Env, 'PASSWORD_ITERATIONS'>): number {
  const workerMaximum = 100_000;
  const databaseMinimum = 100_000;
  const value = Number.parseInt(env.PASSWORD_ITERATIONS || String(workerMaximum), 10);
  const configured = Number.isFinite(value) ? value : workerMaximum;
  return Math.min(workerMaximum, Math.max(databaseMinimum, configured));
}

function referralCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

export async function getDevicePlayerNameAvailability(
  request: Request,
  env: Env,
): Promise<{ available: boolean; display_name: string; claim_state: 'available' | 'login_required' | 'legacy_upgrade_required'; requires_password: boolean }> {
  await enforceRateLimit(request, env, {
    routeKey: 'device-player-name-availability',
    limit: 60,
    windowSeconds: 60,
  });
  const name = validateDisplayName(new URL(request.url).searchParams.get('name'));
  const existing = await env.DB.prepare(
    `SELECT id, auth_kind
       FROM players
      WHERE normalized_name = ? OR UPPER(TRIM(display_name)) = ?
      LIMIT 1`,
  ).bind(name.normalized_name, name.normalized_name).first<{ id: string; auth_kind: 'password' | 'legacy_device' }>();
  return {
    available: !existing,
    display_name: name.display_name,
    claim_state: !existing ? 'available' : existing.auth_kind === 'password' ? 'login_required' : 'legacy_upgrade_required',
    requires_password: Boolean(existing),
  };
}

// Creates an invisible per-installation identity for frictionless leaderboard use.
// The confirmed public name is globally unique and becomes the permanent identity
// key. The generated credential remains private and is never shown to the player.
export async function registerDevicePlayer(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'device-player-register', limit: 12, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const installationId = validateInstallationId(body.installation_id);
  const meta = parsePlatformMeta(body);
  const initialScore = safeInteger(body.initial_score, 1, 99_999_999, 'initial_score');
  const initialLevel = safeOptionalInteger(body.initial_level, 1, 10_000, 'initial_level');
  const occurredAt = safeIsoUtc(body.occurred_at, 'occurred_at');

  const existingInstallation = await env.DB.prepare(
    'SELECT player_id FROM installations WHERE id = ? LIMIT 1',
  ).bind(installationId).first<{ player_id: string | null }>();
  if (existingInstallation) {
    throw new HttpError(409, 'device_already_registered', 'This game installation already has a player identity.');
  }

  const deviceCredential = randomToken(32);
  const credentials = await hashPassword(deviceCredential, passwordIterations(env));
  const playerId = newId();
  const normalizedName = name.normalized_name;
  const existingName = await env.DB.prepare(
    `SELECT id
       FROM players
      WHERE normalized_name = ? OR UPPER(TRIM(display_name)) = ?
      LIMIT 1`,
  ).bind(normalizedName, normalizedName).first<{ id: string }>();
  if (existingName) {
    throw new HttpError(409, 'name_unavailable', 'That leaderboard name is already taken.');
  }
  const now = utcNow();
  const code = referralCode();
  const geography = requestGeography(request);
  const safeBackupPlayer = {
    id: playerId,
    display_name: name.display_name,
    normalized_name: normalizedName,
    password_hash: credentials.hash,
    password_salt: credentials.salt,
    password_iterations: credentials.iterations,
    recovery_email_ciphertext: null,
    recovery_email_iv: null,
    recovery_email_hash: null,
    created_at: now,
    updated_at: now,
  };

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO players
          (id, display_name, normalized_name, password_hash, password_salt, password_iterations,
           auth_kind, recovery_email_ciphertext, recovery_email_iv, recovery_email_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'legacy_device', NULL, NULL, NULL, ?, ?)`,
      ).bind(
        playerId, name.display_name, normalizedName, credentials.hash, credentials.salt,
        credentials.iterations, now, now,
      ),
      env.DB.prepare(
        `INSERT INTO installations
          (id, player_id, source_platform, web_source, device_type, device_model, os_name, os_version,
           app_version, first_seen_at, last_seen_at, country_code, region_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        installationId, playerId, meta.source_platform, meta.web_source, meta.device_type,
        meta.device_model, meta.os_name, meta.os_version, meta.app_version, now, now,
        geography.country_code, geography.region_code,
      ),
      env.DB.prepare(
        'INSERT INTO referral_codes (code, player_id, campaign, created_at) VALUES (?, ?, ?, ?)',
      ).bind(code, playerId, 'device-player', now),
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
        payload: { code, player_id: playerId, campaign: 'device-player', created_at: now },
        occurred_at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new HttpError(409, 'name_unavailable', 'That leaderboard name is already taken.');
    }
    throw error;
  }

  const auth: PlayerAuth = {
    session_id: '',
    player_id: playerId,
    display_name: name.display_name,
    normalized_name: normalizedName,
    password_hash: credentials.hash,
    password_salt: credentials.salt,
    password_iterations: credentials.iterations,
  };
  const initialScoreResult = await submitScore(
    env,
    request,
    auth,
    { score: initialScore, level: initialLevel, occurred_at: occurredAt },
    meta,
  );
  const session = await createPlayerSession(env, playerId);

  return {
    player: {
      id: playerId,
      display_name: name.display_name,
      referral_code: code,
      created_at: now,
    },
    session,
    device_credentials: {
      player_id: playerId,
      credential: deviceCredential,
    },
    initial_score: initialScoreResult,
  };
}

// Re-establishes a session silently after the short-lived bearer session expires.
// Both the hidden player ID and generated credential must match the installation.
export async function createDevicePlayerSession(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'device-player-session', limit: 20, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const playerId = cleanText(body.player_id, 64);
  if (!playerId) throw new HttpError(400, 'invalid_player_id', 'Player identity is required.');
  const installationId = validateInstallationId(body.installation_id);
  const credential = validatePassword(body.credential);

  const player = await env.DB.prepare(
    `SELECT p.id, p.display_name, p.normalized_name, p.password_hash, p.password_salt,
            p.password_iterations, p.created_at
       FROM players p
       JOIN installations i ON i.player_id = p.id
      WHERE p.id = ? AND i.id = ? AND p.deleted_at IS NULL
      LIMIT 1`,
  ).bind(playerId, installationId).first<PlayerAuth & { id: string; created_at: string }>();

  if (!player || !(await verifyPassword(
    credential,
    player.password_hash,
    player.password_salt,
    player.password_iterations,
  ))) {
    throw new HttpError(401, 'invalid_device_credentials', 'The saved game identity is invalid.');
  }

  return {
    player: {
      id: player.id,
      display_name: player.display_name,
      created_at: player.created_at,
    },
    session: await createPlayerSession(env, player.id),
  };
}

export async function registerAccount(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'account-register', limit: 8, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const password = validatePassword(body.password);
  const recoveryEmail = validateRecoveryEmail(body.recovery_email);
  const meta = parsePlatformMeta(body);
  const installationId = meta.installation_id ? validateInstallationId(meta.installation_id) : null;
  const initialScore = safeOptionalInteger(body.initial_score, 1, 99_999_999, 'initial_score');
  const initialLevel = safeOptionalInteger(body.initial_level, 1, 10_000, 'initial_level');
  const credentials = await hashPassword(password, passwordIterations(env));
  const encryptedEmail = recoveryEmail
    ? await encryptRecoveryEmail(recoveryEmail, env.RECOVERY_EMAIL_KEY)
    : null;
  const playerId = newId();
  const now = utcNow();
  const code = referralCode();
  const geography = requestGeography(request);
  if (installationId) {
    const linked = await env.DB.prepare('SELECT player_id FROM installations WHERE id = ?')
      .bind(installationId).first<{ player_id: string | null }>();
    if (linked?.player_id) throw new HttpError(409, 'installation_already_linked', 'This installation is already linked to a leaderboard profile.');
  }
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
           auth_kind, recovery_email_ciphertext, recovery_email_iv, recovery_email_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?)`,
      ).bind(
        playerId, name.display_name, name.normalized_name, credentials.hash, credentials.salt,
        credentials.iterations, encryptedEmail?.ciphertext ?? null, encryptedEmail?.iv ?? null,
        encryptedEmail?.hash ?? null, now, now,
      ),
      env.DB.prepare(
        'INSERT INTO referral_codes (code, player_id, campaign, created_at) VALUES (?, ?, ?, ?)',
      ).bind(code, playerId, 'player', now),
      ...(installationId ? [env.DB.prepare(
        `INSERT INTO installations
          (id, player_id, source_platform, web_source, device_type, device_model, os_name, os_version,
           app_version, first_seen_at, last_seen_at, country_code, region_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET player_id=excluded.player_id, last_seen_at=excluded.last_seen_at`,
      ).bind(installationId, playerId, meta.source_platform, meta.web_source, meta.device_type,
        meta.device_model, meta.os_name, meta.os_version, meta.app_version, now, now,
        geography.country_code, geography.region_code)] : []),
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
  const deviceCredentials = installationId
    ? await issueProfileDeviceCredential(env, playerId, installationId)
    : null;
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
    device_credentials: deviceCredentials,
    initial_score: initialScoreResult,
  };
}

export async function loginAccount(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'account-login', limit: 12, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const password = validatePassword(body.password);
  const meta = parsePlatformMeta(body);
  const installationId = meta.installation_id ? validateInstallationId(meta.installation_id) : null;
  const player = await env.DB.prepare(
    `SELECT id, display_name, normalized_name, password_hash, password_salt, password_iterations, created_at
     FROM players
     WHERE normalized_name = ? AND auth_kind = 'password' AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(name.normalized_name).first<PlayerAuth & { id: string; created_at: string }>();
  if (!player || !(await verifyPassword(password, player.password_hash, player.password_salt, player.password_iterations))) {
    throw new HttpError(401, 'invalid_credentials', 'Player name or password is incorrect.');
  }
  if (installationId) await linkInstallation(request, env, player.id, installationId, meta);
  const session = await createPlayerSession(env, player.id);
  const deviceCredentials = installationId
    ? await issueProfileDeviceCredential(env, player.id, installationId)
    : null;
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
    device_credentials: deviceCredentials,
  };
}

async function linkInstallation(
  request: Request,
  env: Env,
  playerId: string,
  installationId: string,
  meta: ReturnType<typeof parsePlatformMeta>,
): Promise<void> {
  const existing = await env.DB.prepare('SELECT player_id FROM installations WHERE id = ?')
    .bind(installationId).first<{ player_id: string | null }>();
  if (existing?.player_id && existing.player_id !== playerId) {
    throw new HttpError(409, 'installation_linked_to_another_profile', 'This installation is linked to another leaderboard profile.');
  }
  const now = utcNow();
  const geo = requestGeography(request);
  await env.DB.prepare(
    `INSERT INTO installations
      (id, player_id, source_platform, web_source, device_type, device_model, os_name, os_version,
       app_version, first_seen_at, last_seen_at, country_code, region_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET player_id=excluded.player_id, source_platform=excluded.source_platform,
       web_source=excluded.web_source, device_type=excluded.device_type, device_model=excluded.device_model,
       os_name=excluded.os_name, os_version=excluded.os_version, app_version=excluded.app_version,
       last_seen_at=excluded.last_seen_at, country_code=excluded.country_code, region_code=excluded.region_code`,
  ).bind(installationId, playerId, meta.source_platform, meta.web_source, meta.device_type,
    meta.device_model, meta.os_name, meta.os_version, meta.app_version, now, now,
    geo.country_code, geo.region_code).run();
}

async function issueProfileDeviceCredential(
  env: Env,
  playerId: string,
  installationId: string,
): Promise<{ player_id: string; credential: string }> {
  const credential = randomToken(32);
  const now = utcNow();
  await env.DB.prepare(
    `INSERT INTO profile_device_credentials
      (installation_id, player_id, credential_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(installation_id) DO UPDATE SET player_id=excluded.player_id,
       credential_hash=excluded.credential_hash, created_at=excluded.created_at,
       last_used_at=excluded.last_used_at, revoked_at=NULL`,
  ).bind(installationId, playerId, await sha256(credential), now, now).run();
  return { player_id: playerId, credential };
}

export async function createProfileDeviceSession(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'leaderboard-profile-session', limit: 20, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const playerId = cleanText(body.player_id, 64);
  if (!playerId) throw new HttpError(400, 'invalid_player_id', 'Player identity is required.');
  const installationId = validateInstallationId(body.installation_id);
  const credential = typeof body.credential === 'string' ? body.credential : '';
  if (credential.length < 32 || credential.length > 128) {
    throw new HttpError(400, 'invalid_device_credential', 'Saved device credential is invalid.');
  }
  const row = await env.DB.prepare(
    `SELECT p.id, p.display_name, p.created_at, d.credential_hash
       FROM profile_device_credentials d JOIN players p ON p.id=d.player_id
      WHERE d.installation_id=? AND d.player_id=? AND d.revoked_at IS NULL AND p.deleted_at IS NULL`,
  ).bind(installationId, playerId).first<{ id: string; display_name: string; created_at: string; credential_hash: string }>();
  if (!row || !constantTimeEqual(row.credential_hash, await sha256(credential))) {
    throw new HttpError(401, 'invalid_device_credentials', 'The saved leaderboard profile is invalid.');
  }
  await env.DB.prepare('UPDATE profile_device_credentials SET last_used_at=? WHERE installation_id=?')
    .bind(utcNow(), installationId).run();
  return {
    player: { id: row.id, display_name: row.display_name, created_at: row.created_at },
    session: await createPlayerSession(env, row.id),
  };
}

export async function upgradeDevicePlayer(request: Request, env: Env): Promise<Record<string, unknown>> {
  await enforceRateLimit(request, env, { routeKey: 'leaderboard-profile-upgrade', limit: 8, windowSeconds: 900 });
  const body = await readJson<Record<string, unknown>>(request);
  const name = validateDisplayName(body.name);
  const password = validatePassword(body.password);
  const recoveryEmail = validateRecoveryEmail(body.recovery_email);
  const installationId = validateInstallationId(body.installation_id);
  const meta = parsePlatformMeta(body);
  const player = await env.DB.prepare(
    `SELECT id, display_name, normalized_name, password_hash, password_salt, password_iterations, auth_kind, created_at
     FROM players WHERE normalized_name = ? AND deleted_at IS NULL LIMIT 1`,
  ).bind(name.normalized_name).first<PlayerAuth & { id: string; auth_kind: string; created_at: string }>();
  if (!player) throw new HttpError(404, 'profile_not_found', 'That leaderboard profile does not exist.');
  if (player.auth_kind === 'password') throw new HttpError(409, 'profile_already_claimed', 'That name already has a password. Log in instead.');

  const current = await optionalPlayer(request, env);
  let authorized = current?.player_id === player.id;
  if (!authorized && body.credential !== undefined) {
    const credential = validatePassword(body.credential);
    const installation = await env.DB.prepare('SELECT player_id FROM installations WHERE id = ?')
      .bind(installationId).first<{ player_id: string | null }>();
    authorized = installation?.player_id === player.id && await verifyPassword(
      credential, player.password_hash, player.password_salt, player.password_iterations,
    );
  }
  if (!authorized) throw new HttpError(401, 'legacy_credentials_required', 'Use the device where this name was created to set its password.');

  const credentials = await hashPassword(password, passwordIterations(env));
  const encryptedEmail = recoveryEmail ? await encryptRecoveryEmail(recoveryEmail, env.RECOVERY_EMAIL_KEY) : null;
  const now = utcNow();
  try {
    await env.DB.prepare(
      `UPDATE players SET password_hash=?, password_salt=?, password_iterations=?, auth_kind='password',
       recovery_email_ciphertext=?, recovery_email_iv=?, recovery_email_hash=?, updated_at=? WHERE id=?`,
    ).bind(credentials.hash, credentials.salt, credentials.iterations, encryptedEmail?.ciphertext ?? null,
      encryptedEmail?.iv ?? null, encryptedEmail?.hash ?? null, now, player.id).run();
  } catch (error) {
    if (isUniqueConstraint(error)) throw new HttpError(409, 'recovery_email_conflict', 'That recovery email is already registered.');
    throw error;
  }
  await linkInstallation(request, env, player.id, installationId, meta);
  const deviceCredentials = await issueProfileDeviceCredential(env, player.id, installationId);
  return {
    player: { id: player.id, display_name: player.display_name, recovery_email_configured: Boolean(recoveryEmail), created_at: player.created_at },
    session: await createPlayerSession(env, player.id),
    device_credentials: deviceCredentials,
    upgraded_legacy_profile: true,
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
