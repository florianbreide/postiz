/**
 * Test switch for the channel check (PLAN 3.3 PR 19, E23): for 30 minutes
 * DailyHealth sends a deliberately invalid token for one channel, so the
 * platform answers "Zugang ungültig". The stored token stays as it is.
 *
 * Only with YSOCIAL_TEST_ROUTES=true and only for the channels listed in
 * YSOCIAL_TEST_INTEGRATIONS (ids, comma separated). Both sides check this:
 * the backend route that sets the switch and the channel check that reads
 * it. The switch lives in the Redis of Postiz with a TTL, no table
 * (HANDOVER §5).
 */

export const YSOCIAL_TEST_ROUTES_ENV = 'YSOCIAL_TEST_ROUTES';
export const YSOCIAL_TEST_INTEGRATIONS_ENV = 'YSOCIAL_TEST_INTEGRATIONS';

export const INVALID_TOKEN_SWITCH_TTL_S = 30 * 60;

// Sent to the platform instead of the stored token. No platform issues
// tokens of this form.
export const YSOCIAL_TEST_INVALID_TOKEN = 'ysocial-test-invalid-token';

export const invalidTokenSwitchKey = (integrationId: string) =>
  `ysocial:test:invalid-token:${integrationId}`;

// Stored value: {"since":"…","until":"…"}. The switch is on only until
// "until" and never longer than the TTL, even where Redis ignores the TTL
// (the Postiz mock without REDIS_URL) or a key was set by hand. Anything
// else counts as off.
export const invalidTokenSwitchActive = (
  raw: string | null | undefined,
  now: number
) => {
  try {
    const until = Date.parse(JSON.parse(raw || '{}')?.until);
    return until > now && until <= now + INVALID_TOKEN_SWITCH_TTL_S * 1000;
  } catch (err) {
    return false;
  }
};

type Env = Record<string, string | undefined>;

export const testRoutesEnabled = (env: Env) =>
  env[YSOCIAL_TEST_ROUTES_ENV] === 'true';

export const testIntegrationIds = (env: Env) =>
  (env[YSOCIAL_TEST_INTEGRATIONS_ENV] || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

export const isTestIntegration = (env: Env, integrationId: string) =>
  testRoutesEnabled(env) && testIntegrationIds(env).includes(integrationId);
