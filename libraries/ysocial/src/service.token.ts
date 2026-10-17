import { createHash, timingSafeEqual } from 'crypto';

/**
 * Shared check for the internal ysocial service token.
 *
 * Fail-closed (HANDOVER §9, rule 3): if the token is not configured, nobody
 * gets in. The comparison is constant-time and does not leak the length of
 * the configured token.
 */

export const YSOCIAL_SERVICE_TOKEN_ENV = 'YSOCIAL_SERVICE_TOKEN';

// A configured token shorter than this counts as "not configured".
export const YSOCIAL_SERVICE_TOKEN_MIN_LENGTH = 32;

export type ServiceTokenResult =
  | 'ok'
  | 'not_configured'
  | 'missing'
  | 'invalid';

export const isServiceTokenConfigured = (
  configured?: string
): configured is string =>
  typeof configured === 'string' &&
  configured.trim().length >= YSOCIAL_SERVICE_TOKEN_MIN_LENGTH;

export const readBearerToken = (
  authorization?: string | string[]
): string | undefined => {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value.trim());
  return match ? match[1] : undefined;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

export const tokensMatch = (expected: string, provided: string): boolean =>
  timingSafeEqual(digest(expected), digest(provided));

export const checkServiceToken = (
  configured: string | undefined,
  authorization?: string | string[]
): ServiceTokenResult => {
  if (!isServiceTokenConfigured(configured)) {
    return 'not_configured';
  }

  const provided = readBearerToken(authorization);
  if (!provided) {
    return 'missing';
  }

  return tokensMatch(configured.trim(), provided) ? 'ok' : 'invalid';
};
