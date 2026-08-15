import { describe, expect, it } from 'vitest';
import {
  decryptRecoveryEmail,
  encryptRecoveryEmail,
  hashPassword,
  randomToken,
  verifyPassword,
} from '../src/crypto';

describe('account cryptography', () => {
  it('hashes and verifies passwords without storing plaintext', async () => {
    const result = await hashPassword('correct horse battery staple', 100_000);
    expect(result.hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', result.hash, result.salt, result.iterations)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', result.hash, result.salt, result.iterations)).resolves.toBe(false);
  });

  it('encrypts optional recovery email', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const encrypted = await encryptRecoveryEmail('player@example.com', key);
    expect(encrypted.ciphertext).not.toContain('player@example.com');
    await expect(decryptRecoveryEmail(encrypted.ciphertext, encrypted.iv, key)).resolves.toBe('player@example.com');
  });

  it('generates opaque session tokens', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});
