import type { Context } from 'hono';
import { HttpError, type Env } from './types';

export function utcNow(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'content_type_required', 'Content-Type must be application/json.');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

export function jsonOk<T>(c: Context<{ Bindings: Env }>, data: T, status = 200): Response {
  return c.json({ ok: true, data, server_time: utcNow() }, status as 200);
}

export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function safeInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new HttpError(400, 'invalid_field', `${field} must be an integer from ${min} to ${max}.`, { field });
  }
  return value as number;
}

export function safeOptionalInteger(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number | null {
  if (value === undefined || value === null) return null;
  return safeInteger(value, min, max, field);
}

export function safeIsoUtc(value: unknown, field: string, fallback = utcNow()): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_field', `${field} must be an ISO-8601 timestamp.`, { field });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new HttpError(400, 'invalid_field', `${field} must be an ISO-8601 timestamp.`, { field });
  }
  return parsed.toISOString();
}

export function requestGeography(request: Request): { country_code: string | null; region_code: string | null } {
  const cf = request.cf as { country?: string; regionCode?: string } | undefined;
  const country = cleanText(cf?.country, 2)?.toUpperCase() ?? null;
  const region = cleanText(cf?.regionCode, 8)?.toUpperCase() ?? null;
  return { country_code: country, region_code: region };
}

export function requestId(request: Request): string {
  return request.headers.get('cf-ray') || newId();
}
