import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/cors';

const origins = [
  'https://www.cavemanvsdragon.com',
  'https://cavemanvsdragon-*-jwshin1-5345s-projects.vercel.app',
].join(',');

describe('CORS origin matching', () => {
  it('allows exact production and scoped Vercel preview origins', () => {
    expect(isAllowedOrigin('https://www.cavemanvsdragon.com', origins)).toBe(true);
    expect(isAllowedOrigin(
      'https://cavemanvsdragon-oda66n0t4-jwshin1-5345s-projects.vercel.app',
      origins,
    )).toBe(true);
  });

  it('rejects look-alike hosts and wildcard values containing separators', () => {
    expect(isAllowedOrigin(
      'https://cavemanvsdragon-oda66n0t4-attacker.vercel.app',
      origins,
    )).toBe(false);
    expect(isAllowedOrigin(
      'https://cavemanvsdragon-oda66n0t4-jwshin1-5345s-projects.vercel.app.evil.example',
      origins,
    )).toBe(false);
    expect(isAllowedOrigin(
      'https://cavemanvsdragon-a.b-jwshin1-5345s-projects.vercel.app',
      origins,
    )).toBe(false);
  });

  it('rejects absent and malformed origins', () => {
    expect(isAllowedOrigin(undefined, origins)).toBe(false);
    expect(isAllowedOrigin('not-an-origin', origins)).toBe(false);
  });
});
