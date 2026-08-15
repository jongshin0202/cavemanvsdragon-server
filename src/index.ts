import { Hono } from 'hono';
import { requireAdmin, requirePlayer } from './auth';
import {
  analyticsSummary,
  backupStatus,
  clearPrimaryLeaderboard,
  createClearChallenge,
  createRestoreChallenge,
  deleteLeaderboardEntry,
  exportLeaderboardCsv,
  listAdminLeaderboard,
  listAuditLogs,
  reorderLeaderboard,
  restorePrimaryLeaderboardFromBackup,
  undoAdminAction,
  updateLeaderboardEntry,
} from './admin';
import { ADMIN_HTML } from './admin-ui';
import {
  deleteAccountPermanently,
  getAccount,
  loginAccount,
  logoutAccount,
  registerAccount,
} from './accounts';
import { recordAnalytics } from './analytics';
import { flushBackupOutbox } from './backup';
import { jsonOk, readJson, requestId } from './http';
import { getLeaderboard, submitScore } from './leaderboard';
import { cleanExpiredRateLimits, enforceRateLimit } from './rate-limit';
import { createShare, openReferral } from './sharing';
import { HttpError, type Env } from './types';
import { parsePlatformMeta } from './validation';

type AppContext = { Bindings: Env };
const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = new Set((c.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));
  if (origin && allowed.has(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Actor');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Max-Age', '86400');
    c.header('Vary', 'Origin');
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') {
    if (origin && !allowed.has(origin)) return c.json({ ok: false, error: { code: 'origin_not_allowed' } }, 403);
    return c.body(null, 204);
  }
  await next();
});

app.onError((error, c) => {
  const id = requestId(c.req.raw);
  if (error instanceof HttpError) {
    if (error.status === 429 && typeof error.details === 'object' && error.details) {
      const retry = (error.details as { retry_after_seconds?: number }).retry_after_seconds;
      if (retry) c.header('Retry-After', String(retry));
    }
    return c.json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
      request_id: id,
    }, error.status as 400);
  }
  console.error('Unhandled request error', { request_id: id, error });
  return c.json({
    ok: false,
    error: { code: 'internal_error', message: 'The server could not complete the request.' },
    request_id: id,
  }, 500);
});

app.notFound((c) => c.json({
  ok: false,
  error: { code: 'not_found', message: 'Route not found.' },
  request_id: requestId(c.req.raw),
}, 404));

app.get('/health', (c) => jsonOk(c, {
  status: 'ok',
  service: 'cavemanvsdragon-api',
  version: '0.1.0',
  environment: c.env.ENVIRONMENT,
}));

app.get('/v1/config', async (c) => {
  const flags = await c.env.DB.prepare(
    'SELECT key, enabled, config_json, updated_at FROM feature_flags ORDER BY key',
  ).all();
  return jsonOk(c, {
    api_version: 'v1',
    player_name_max_length: 10,
    global_leaderboard_policy: 'one_entry_per_player_highest_score_only',
    timestamps: 'UTC',
    feature_flags: flags.results,
  });
});

app.get('/v1/leaderboard', async (c) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query('limit') || '20', 10) || 20));
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') || '0', 10) || 0);
  return jsonOk(c, await getLeaderboard(c.env, limit, offset, false));
});

app.post('/v1/accounts/register', async (c) => {
  const result = await registerAccount(c.req.raw, c.env);
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result, 201);
});

app.post('/v1/accounts/login', async (c) => jsonOk(c, await loginAccount(c.req.raw, c.env)));
app.post('/v1/accounts/logout', async (c) => {
  await logoutAccount(c.req.raw, c.env);
  return jsonOk(c, { logged_out: true });
});
app.get('/v1/account', async (c) => jsonOk(c, await getAccount(c.req.raw, c.env)));
app.delete('/v1/account', async (c) => {
  const result = await deleteAccountPermanently(c.req.raw, c.env);
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result);
});

app.post('/v1/scores', async (c) => {
  await enforceRateLimit(c.req.raw, c.env, { routeKey: 'score-submit', limit: 30, windowSeconds: 60 });
  const auth = await requirePlayer(c.req.raw, c.env);
  const body = await readJson<Record<string, unknown>>(c.req.raw);
  const meta = parsePlatformMeta(body);
  const result = await submitScore(c.env, c.req.raw, auth, body, meta);
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result, 201);
});

app.post('/v1/analytics/events', async (c) => jsonOk(c, await recordAnalytics(c.req.raw, c.env), 202));
app.post('/v1/shares', async (c) => {
  const result = await createShare(c.req.raw, c.env);
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result, 201);
});
app.get('/r/:code', (c) => openReferral(c.req.raw, c.env, c.req.param('code')));

// The admin page intentionally has a stricter CSP than the JSON API. Its only
// script/style are in the trusted, versioned response below.
app.get('/admin', (c) => {
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  c.header('Cache-Control', 'no-store');
  return c.html(ADMIN_HTML);
});

app.get('/v1/admin/leaderboard', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await listAdminLeaderboard(c.env, new URL(c.req.url)));
});
app.get('/v1/admin/leaderboard/export.csv', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  const csv = await exportLeaderboardCsv(c.env);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cavemanvsdragon-global-leaderboard.csv"',
      'Cache-Control': 'no-store',
    },
  });
});
app.patch('/v1/admin/leaderboard/:playerId', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  const result = await updateLeaderboardEntry(c.req.raw, c.env, admin, c.req.param('playerId'));
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result);
});
app.delete('/v1/admin/leaderboard/:playerId', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  const result = await deleteLeaderboardEntry(c.req.raw, c.env, admin, c.req.param('playerId'));
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result);
});
app.post('/v1/admin/leaderboard/reorder', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  const result = await reorderLeaderboard(c.req.raw, c.env, admin);
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result);
});
app.post('/v1/admin/leaderboard/clear/challenge', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await createClearChallenge(c.env, admin), 201);
});
app.post('/v1/admin/leaderboard/clear', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await clearPrimaryLeaderboard(c.req.raw, c.env, admin));
});
app.post('/v1/admin/audit/:auditId/undo', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  const result = await undoAdminAction(c.env, admin, c.req.param('auditId'));
  c.executionCtx.waitUntil(flushBackupOutbox(c.env));
  return jsonOk(c, result);
});
app.get('/v1/admin/audit', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await listAuditLogs(c.env, new URL(c.req.url)));
});
app.get('/v1/admin/analytics/summary', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await analyticsSummary(c.env, new URL(c.req.url)));
});
app.get('/v1/admin/backups/status', async (c) => {
  await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await backupStatus(c.env));
});
app.post('/v1/admin/backups/restore-leaderboard/challenge', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await createRestoreChallenge(c.env, admin), 201);
});
app.post('/v1/admin/backups/restore-leaderboard', async (c) => {
  const admin = await requireAdmin(c.req.raw, c.env);
  return jsonOk(c, await restorePrimaryLeaderboardFromBackup(c.req.raw, c.env, admin));
});

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([
      flushBackupOutbox(env, 500),
      cleanExpiredRateLimits(env),
      env.DB.prepare('DELETE FROM player_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL')
        .bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).run(),
      env.DB.prepare('DELETE FROM admin_confirmation_challenges WHERE expires_at < ?')
        .bind(new Date(Date.now() - 86_400_000).toISOString()).run(),
    ]).then(() => undefined));
  },
};

export default worker;
