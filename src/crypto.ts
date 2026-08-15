import { HttpError } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hashPassword(
  password: string,
  iterations: number,
  salt = randomToken(18),
): Promise<{ hash: string; salt: string; iterations: number }> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return { hash: bytesToBase64Url(new Uint8Array(bits)), salt, iterations };
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string,
  iterations: number,
): Promise<boolean> {
  const calculated = await hashPassword(password, iterations, salt);
  return constantTimeEqual(calculated.hash, expectedHash);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function encryptRecoveryEmail(
  email: string,
  base64Key: string | undefined,
): Promise<{ ciphertext: string; iv: string; hash: string }> {
  if (!base64Key) {
    throw new HttpError(503, 'recovery_email_unavailable', 'Recovery email is temporarily unavailable.');
  }
  let rawKey: Uint8Array;
  try {
    rawKey = base64ToBytes(base64Key);
  } catch {
    throw new HttpError(503, 'server_configuration_error', 'Recovery email encryption is not configured.');
  }
  if (rawKey.byteLength !== 32) {
    throw new HttpError(503, 'server_configuration_error', 'Recovery email encryption is not configured.');
  }
  const key = await crypto.subtle.importKey('raw', asArrayBuffer(rawKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(email));
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    hash: await sha256(email.toLowerCase()),
  };
}

export async function decryptRecoveryEmail(
  ciphertext: string,
  iv: string,
  base64Key: string,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', asArrayBuffer(base64ToBytes(base64Key)), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(base64ToBytes(iv)) },
    key,
    asArrayBuffer(base64ToBytes(ciphertext)),
  );
  return decoder.decode(plaintext);
}
