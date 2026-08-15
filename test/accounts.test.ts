import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { passwordIterations } from '../src/accounts';

describe('account password policy', () => {
  it.each([
    ['the configured Worker value', '100000'],
    ['a value above the Workers Web Crypto maximum', '600000'],
    ['a value below the database minimum', '50000'],
    ['an invalid value', 'invalid'],
    ['an empty value', ''],
  ])('uses exactly 100,000 iterations for %s', (_description, configured) => {
    expect(passwordIterations({ PASSWORD_ITERATIONS: configured })).toBe(100_000);
  });

  it('configures every Wrangler environment for 100,000 iterations', () => {
    const config = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as {
      vars: { PASSWORD_ITERATIONS: string };
      env: Record<string, { vars: { PASSWORD_ITERATIONS: string } }>;
    };

    expect(config.vars.PASSWORD_ITERATIONS).toBe('100000');
    expect(Object.values(config.env).map((environment) => environment.vars.PASSWORD_ITERATIONS))
      .toEqual(['100000', '100000']);
  });
});
