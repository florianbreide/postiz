/**
 * What the answer of the provider method analytics (one day) says about the
 * stored channel token (PLAN E23: "Meldet der Provider einen Auth-Fehler,
 * heißt das Zugang ungültig").
 *
 * - Every provider: a RefreshToken or Disconnect failure of SocialAbstract
 *   means "Zugang ungültig".
 * - facebook throws a plain Error with the Graph message. Messages of the
 *   OAuth errors (code 190 and the like) mean "Zugang ungültig".
 * - instagram swallows Graph errors and answers with an empty list. Empty is
 *   therefore "unklar", no alarm. A revoked Instagram token shows up in the
 *   post check.
 * - Anything else that fails is "unklar": rate limits, outages, missing
 *   permissions for a metric. No alarm, but in the daily summary.
 */

export type ChannelAuthResult =
  | { result: 'ok' }
  | { result: 'auth_invalid'; reason: string }
  | { result: 'unclear'; reason: string };

const META_AUTH_ERROR =
  /access token|session has expired|session is invalid|has not authorized|has been invalidated|oauthexception|\(#190\)|code 190|changed the password/i;

const META_PROVIDERS = new Set([
  'facebook',
  'instagram',
  'instagram-standalone',
]);
const EMPTY_IS_UNCLEAR = new Set(['instagram', 'instagram-standalone']);

const failureType = (err: unknown) =>
  (err as { type?: string } | undefined)?.type;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err ?? '');

export const classifyAnalyticsError = (
  providerIdentifier: string,
  err: unknown
): ChannelAuthResult => {
  const type = failureType(err);
  if (type === 'refresh_token' || type === 'disconnect') {
    return {
      result: 'auth_invalid',
      reason: 'Postiz meldet: Zugang muss erneuert werden.',
    };
  }

  const message = messageOf(err);
  if (META_PROVIDERS.has(providerIdentifier) && META_AUTH_ERROR.test(message)) {
    return { result: 'auth_invalid', reason: `Meta meldet: ${message}` };
  }

  return { result: 'unclear', reason: `Prüfung ohne Ergebnis: ${message}` };
};

export const classifyAnalyticsResult = (
  providerIdentifier: string,
  result: unknown
): ChannelAuthResult => {
  if (
    EMPTY_IS_UNCLEAR.has(providerIdentifier) &&
    (!Array.isArray(result) || result.length === 0)
  ) {
    return {
      result: 'unclear',
      reason:
        'Instagram antwortet ohne Kennzahlen, auch bei ungültigem Zugang.',
    };
  }
  return { result: 'ok' };
};
