import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/types';
import { parsePlatformMeta, validateDisplayName, validatePassword } from '../src/validation';

describe('player validation', () => {
  it('accepts and normalizes a valid name', () => {
    expect(validateDisplayName('  Cave Man  ')).toEqual({
      display_name: 'Cave Man',
      normalized_name: 'CAVE MAN',
    });
  });

  it.each(['', '   ', 'ABCDEFGHIJK', 'Bad<Name', 'sh1t'])('rejects invalid name %j', (name) => {
    expect(() => validateDisplayName(name)).toThrow(HttpError);
  });

  it('requires a non-trivial password', () => {
    expect(() => validatePassword('short')).toThrow(HttpError);
    expect(validatePassword('long-enough-password')).toBe('long-enough-password');
  });
});

describe('platform metadata', () => {
  it('retains explicit Android device metadata without fingerprinting fields', () => {
    expect(parsePlatformMeta({
      installation_id: 'random_installation_123',
      source_platform: 'android',
      device_type: 'handheld',
      device_model: 'Arcade Handheld',
      os_name: 'Android',
      os_version: '16',
      app_version: '1.2.0',
      control_type: 'gamepad',
    })).toEqual({
      installation_id: 'random_installation_123',
      source_platform: 'android',
      web_source: null,
      device_type: 'handheld',
      device_model: 'Arcade Handheld',
      os_name: 'Android',
      os_version: '16',
      app_version: '1.2.0',
      control_type: 'gamepad',
    });
  });
});
