import { cleanText } from './http';
import {
  HttpError,
  type ControlType,
  type DeviceType,
  type PlatformMeta,
  type SourcePlatform,
  type WebSource,
} from './types';

const BANNED_ROOTS = [
  'fuck', 'fuk', 'phuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy',
  'asshole', 'bastard', 'slut', 'whore', 'faggot', 'nigger', 'nigga',
  'retard', 'rapist', 'nazi', 'hitler', 'porn', 'penis', 'vagina',
];

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

function normalizedProfanityInput(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    if (LEET[char]) out += LEET[char];
    else if (/[a-z0-9]/.test(char)) out += char;
  }
  return out;
}

export function validateDisplayName(value: unknown): { display_name: string; normalized_name: string } {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'invalid_name', 'Player name is required.');
  }
  const displayName = value.trim().replace(/\s+/g, ' ');
  if (!displayName) throw new HttpError(400, 'invalid_name', 'Player name cannot be empty or whitespace.');
  if (displayName.length > 10) throw new HttpError(400, 'invalid_name', 'Player name is limited to 10 characters.');
  if (!/^[A-Za-z0-9 ]+$/.test(displayName)) {
    throw new HttpError(400, 'invalid_name', 'Player name may use letters, numbers, and spaces only.');
  }
  const profanityInput = normalizedProfanityInput(displayName);
  if (BANNED_ROOTS.some((root) => profanityInput.includes(root))) {
    throw new HttpError(400, 'invalid_name', 'Player name is not allowed.');
  }
  return { display_name: displayName, normalized_name: displayName.toUpperCase() };
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 128) {
    throw new HttpError(400, 'invalid_password', 'Password must be 5 to 128 characters.');
  }
  return value;
}

export function validateRecoveryEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_email', 'Recovery email is invalid.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'invalid_email', 'Recovery email is invalid.');
  }
  return email;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, 'invalid_field', `${field} is invalid.`, { field, allowed });
  }
  return value as T;
}

function optionalOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T | null,
): T | null {
  if (value === undefined || value === null || value === '') return fallback;
  return oneOf(value, allowed, field);
}

export function parsePlatformMeta(body: Record<string, unknown>): PlatformMeta {
  const platforms = ['android', 'ios', 'web'] as const satisfies readonly SourcePlatform[];
  const webSources = ['desktop_web', 'mobile_web', 'pwa', 'embedded', 'unknown'] as const satisfies readonly WebSource[];
  const deviceTypes = ['phone', 'tablet', 'desktop', 'tv', 'handheld', 'unknown'] as const satisfies readonly DeviceType[];
  const controls = ['keyboard', 'touch', 'gamepad', 'mixed', 'unknown'] as const satisfies readonly ControlType[];
  const sourcePlatform = oneOf(body.source_platform, platforms, 'source_platform');
  const webSource = sourcePlatform === 'web'
    ? optionalOneOf(body.web_source, webSources, 'web_source', 'unknown')
    : null;
  return {
    installation_id: cleanText(body.installation_id, 64) ?? undefined,
    source_platform: sourcePlatform,
    web_source: webSource,
    device_type: oneOf(body.device_type, deviceTypes, 'device_type'),
    device_model: cleanText(body.device_model, 80),
    os_name: cleanText(body.os_name, 40),
    os_version: cleanText(body.os_version, 40),
    app_version: cleanText(body.app_version, 40),
    control_type: optionalOneOf(body.control_type, controls, 'control_type', 'unknown'),
  };
}

export function validateInstallationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) {
    throw new HttpError(400, 'invalid_installation_id', 'installation_id must be a random 16-64 character identifier.');
  }
  return value;
}

export function validateReferralCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{6,32}$/.test(value)) {
    throw new HttpError(400, 'invalid_referral_code', 'Referral code is invalid.');
  }
  return value;
}
