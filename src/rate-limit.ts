import { hmacSha256 } from './crypto';
import { HttpError, type Env } from './types';

interface RateLimitOptions {
  routeKey: string;
  limit: number;
  windowSeconds: number;
}

export async function enforceRateLimit(
  request: Request,
  env: Env,
  options: RateLimitOptions,
): Promise<void> {
  if (!env.RATE_LIMIT_SECRET) {
    throw new HttpError(503, 'server_configuration_error', 'Rate limiting is not configured.');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSeconds / options.windowSeconds) * options.windowSeconds;
  const expiresAt = windowStart + options.windowSeconds * 2;
  // The IP is used only in-memory to produce a rotating HMAC. Raw IPs are
  // never written to D1, logs, analytics, or backup storage.
  const rawIp = request.headers.get('cf-connecting-ip') || 'local-development';
  const rotation = new Date(windowStart * 1000).toISOString().slice(0, 10);
  const identifierHash = await hmacSha256(env.RATE_LIMIT_SECRET, `${rotation}|${rawIp}|${options.routeKey}`);
  const result = await env.DB.prepare(
    `INSERT INTO rate_limit_windows
      (identifier_hash, route_key, window_start, request_count, expires_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(identifier_hash, route_key, window_start)
     DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(identifierHash, options.routeKey, windowStart, expiresAt).first<{ request_count: number }>();
  if ((result?.request_count ?? 1) > options.limit) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please try again shortly.', {
      retry_after_seconds: Math.max(1, windowStart + options.windowSeconds - nowSeconds),
    });
  }
}

export async function cleanExpiredRateLimits(env: Env): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM rate_limit_windows WHERE expires_at < ?')
    .bind(nowSeconds).run();
}
