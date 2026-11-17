import { RevokeResult } from './deletion.rules';

/**
 * Revoke of an authorization at the platform, for the deletion job
 * (deletion.rules.ts). Read on 17.11.2026.
 *
 * TikTok: POST /v2/oauth/revoke/ with client_key, client_secret and token
 * ("The user access token to revoke") as form data. It "disconnects your app
 * from the user's TikTok account". Success: an empty body {}. TikTok wants
 * it: "When the user disconnects your app, your server revokes the access
 * token."
 * https://developers.tiktok.com/docs/en/oauth-revoke-a-user-access-token
 * https://developers.tiktok.com/doc/oauth-user-access-token-management
 *
 * Deliberately no revoke for Meta and Google, although both document one:
 * - Meta, DELETE /{user-id}/permissions "completely de-authorize[s] an app",
 *   "any user access token for the person will be invalidated".
 *   https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke
 * - Google, POST https://oauth2.googleapis.com/revoke: "Revocation removes
 *   all OAuth 2.0 scopes previously granted to a project".
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 * Both end the authorization of the person, for every channel connected with
 * it. Postiz does not say reliably which channels those are: "reconnect
 * channel" (reConnect, no.auth.integrations.controller.ts) writes the tokens
 * of whoever clicks into the row, but leaves rootInternalId at the person
 * who connected first (createOrUpdateIntegration, update branch). A revoke
 * could end a connected channel (review of PR D1). The job clears the tokens
 * only.
 *
 * None documented: LinkedIn (Microsoft Learn names introspection only) and
 * Instagram Login (instagram-standalone, Business Login names none).
 *
 * The token goes only into the form body, never into a log, an error or a
 * result.
 */

const REVOKE_TIMEOUT_MS = 15_000;

export interface RevokeTokens {
  token: string;
  refreshToken: string | null;
  // grantIdentities of the row, see deletion.rules.ts.
  identities: string[];
}

export interface PlatformRevoker {
  // Providers that share one authorization at the platform. A revoke ends it
  // for all of them, so the job looks at every channel of the family.
  family: string[];
  // Before the revoke: a fresh access token, whose token it is. Returns the
  // token for revoke, or a result that ends here.
  prepare(
    tokens: RevokeTokens
  ): Promise<{ token: string } | { result: RevokeResult }>;
  // Ends the authorization. Called only after the job checked the channel
  // once more.
  revoke(token: string): Promise<RevokeResult>;
}

interface PlatformAnswer {
  status: number;
  // The parsed body, undefined when it is not JSON.
  json: unknown;
}

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// undefined: no answer, network error or timeout. The cause is not passed on.
const formPost = async (
  url: string,
  values: Record<string, string>
): Promise<PlatformAnswer | undefined> => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => undefined);
    return { status: res.status, json };
  } catch (err) {
    return undefined;
  }
};

/**
 * TikTok. The access token lives 24 hours (tiktok.provider.ts). After the
 * grace period it has long expired, and the revoke takes only an access
 * token. So first a refresh as in tiktok.provider.ts, then the revoke with the
 * fresh token. Without a refresh token there is nothing to revoke with. The
 * refresh answers with open_id: only the account of this row.
 * invalid_grant: "refresh token is invalid, expired, revoked" (TikTok, Error
 * Handling).
 */
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

const tiktokClient = () => {
  const clientKey = process.env.TIKTOK_CLIENT_ID;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  return clientKey && clientSecret ? { clientKey, clientSecret } : undefined;
};

const tiktok: PlatformRevoker = {
  family: ['tiktok'],
  async prepare({ refreshToken, identities }) {
    const client = tiktokClient();
    if (!client) {
      return { result: 'not_configured' };
    }
    if (!refreshToken) {
      return { result: 'no_refresh_token' };
    }
    const answer = await formPost(TIKTOK_TOKEN_URL, {
      client_key: client.clientKey,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (!answer) {
      return { result: 'failed' };
    }
    const body = isObject(answer.json) ? answer.json : {};
    if (body.error === 'invalid_grant') {
      return { result: 'already_invalid' };
    }
    if (
      answer.status !== 200 ||
      typeof body.access_token !== 'string' ||
      !body.access_token ||
      typeof body.open_id !== 'string'
    ) {
      return { result: 'failed' };
    }
    // Postiz stores open_id without dashes as internalId.
    return identities.includes(body.open_id.replace(/-/g, ''))
      ? { token: body.access_token }
      : { result: 'token_mismatch' };
  },
  async revoke(accessToken) {
    const client = tiktokClient();
    if (!client) {
      return 'not_configured';
    }
    const answer = await formPost(TIKTOK_REVOKE_URL, {
      client_key: client.clientKey,
      client_secret: client.clientSecret,
      token: accessToken,
    });
    return answer &&
      answer.status >= 200 &&
      answer.status < 300 &&
      isObject(answer.json) &&
      !answer.json.error
      ? 'revoked'
      : 'failed';
  },
};

export const PLATFORM_REVOKERS: Record<string, PlatformRevoker> = {
  tiktok,
};
