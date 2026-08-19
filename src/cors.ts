const SAFE_WILDCARD_VALUE = /^[a-z0-9-]+$/i;

function matchesConfiguredOrigin(origin: string, configuredOrigin: string): boolean {
  if (!configuredOrigin.includes('*')) return origin === configuredOrigin;
  if ((configuredOrigin.match(/\*/g) ?? []).length !== 1) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return false;
  } catch {
    return false;
  }

  const wildcardIndex = configuredOrigin.indexOf('*');
  const prefix = configuredOrigin.slice(0, wildcardIndex);
  const suffix = configuredOrigin.slice(wildcardIndex + 1);
  if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) return false;

  const wildcardValue = origin.slice(prefix.length, origin.length - suffix.length);
  return wildcardValue.length > 0 && SAFE_WILDCARD_VALUE.test(wildcardValue);
}

export function isAllowedOrigin(origin: string | undefined, configuredOrigins: string): boolean {
  if (!origin) return false;

  return configuredOrigins
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .some((configuredOrigin) => matchesConfiguredOrigin(origin, configuredOrigin));
}
