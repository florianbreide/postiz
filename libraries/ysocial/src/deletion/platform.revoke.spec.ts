import { PLATFORM_REVOKERS, RevokeTokens } from './platform.revoke';

// Invented values only.
const USER_TOKEN = 'test-user-token-1';
const PAGE_TOKEN = 'test-page-token-1';
const REFRESH = 'test-refresh-token-1';
const ACCESS = 'test-access-token-2';

const reply = (status: number, body?: unknown) => ({
  status,
  json: async () => {
    if (body === undefined) {
      throw new Error('no json');
    }
    return body;
  },
});

const tokens = (patch: Partial<RevokeTokens> = {}): RevokeTokens => ({
  token: PAGE_TOKEN,
  refreshToken: USER_TOKEN,
  identities: ['user-1', 'page-1'],
  ...patch,
});

const env = { ...process.env };
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  process.env.TIKTOK_CLIENT_ID = 'test-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'test-client-secret';
});

afterAll(() => {
  process.env = env;
});

const noSecretIn = (value: unknown) => {
  const text = JSON.stringify(value) ?? '';
  for (const secret of [
    USER_TOKEN,
    PAGE_TOKEN,
    REFRESH,
    ACCESS,
    'test-client-secret',
  ]) {
    expect(text).not.toContain(secret);
  }
};

describe('PLATFORM_REVOKERS', () => {
  it('has only TikTok', () => {
    expect(Object.keys(PLATFORM_REVOKERS)).toEqual(['tiktok']);
    expect(PLATFORM_REVOKERS.tiktok.family).toEqual(['tiktok']);
  });

  it('has no entry for the platforms without a safe revoke', () => {
    for (const none of [
      'facebook',
      'instagram',
      'youtube',
      'gmb',
      'linkedin',
      'linkedin-page',
      'instagram-standalone',
    ]) {
      expect(PLATFORM_REVOKERS[none]).toBeUndefined();
    }
  });
});

describe('TikTok', () => {
  const revoker = PLATFORM_REVOKERS.tiktok;
  const body = (call: number) =>
    new URLSearchParams(fetchMock.mock.calls[call][1].body);

  it('is not_configured without client credentials, no fetch', async () => {
    delete process.env.TIKTOK_CLIENT_ID;
    expect(await revoker.prepare(tokens())).toEqual({
      result: 'not_configured',
    });
    process.env.TIKTOK_CLIENT_ID = 'test-client-key';
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect(await revoker.prepare(tokens())).toEqual({
      result: 'not_configured',
    });
    expect(await revoker.revoke(ACCESS)).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes (form POST), checks open_id and returns the new access token', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { access_token: ACCESS, open_id: 'open-id-1' })
    );
    const result = await revoker.prepare(
      tokens({ refreshToken: REFRESH, identities: ['openid1'] })
    );
    expect(result).toEqual({ token: ACCESS });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://open.tiktokapis.com/v2/oauth/token/');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(Object.fromEntries(body(0))).toEqual({
      client_key: 'test-client-key',
      client_secret: 'test-client-secret',
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
    });
    expect(url).not.toContain(REFRESH);
  });

  it('returns token_mismatch when open_id is another account, without revoke', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { access_token: ACCESS, open_id: 'other-id' })
    );
    expect(
      await revoker.prepare(
        tokens({ refreshToken: REFRESH, identities: ['openid1'] })
      )
    ).toEqual({ result: 'token_mismatch' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns already_invalid for invalid_grant at the refresh', async () => {
    fetchMock.mockResolvedValue(reply(400, { error: 'invalid_grant' }));
    expect(
      await revoker.prepare(tokens({ refreshToken: REFRESH }))
    ).toEqual({ result: 'already_invalid' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns failed for other refresh problems', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await revoker.prepare(tokens({ refreshToken: REFRESH }))).toEqual({
      result: 'failed',
    });
    fetchMock.mockResolvedValueOnce(reply(500, { error: 'server_error' }));
    expect(await revoker.prepare(tokens({ refreshToken: REFRESH }))).toEqual({
      result: 'failed',
    });
    fetchMock.mockResolvedValueOnce(reply(200, { open_id: 'openid1' }));
    expect(await revoker.prepare(tokens({ refreshToken: REFRESH }))).toEqual({
      result: 'failed',
    });
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: ACCESS }));
    expect(await revoker.prepare(tokens({ refreshToken: REFRESH }))).toEqual({
      result: 'failed',
    });
    fetchMock.mockResolvedValueOnce(reply(200));
    expect(await revoker.prepare(tokens({ refreshToken: REFRESH }))).toEqual({
      result: 'failed',
    });
  });

  it('returns no_refresh_token without a call when there is no refresh token', async () => {
    for (const refreshToken of [null, '']) {
      expect(
        await revoker.prepare(tokens({ refreshToken, token: ACCESS }))
      ).toEqual({ result: 'no_refresh_token' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes with client_key, client_secret and token in the form body', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await revoker.revoke(ACCESS)).toBe('revoked');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://open.tiktokapis.com/v2/oauth/revoke/');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(body(0))).toEqual({
      client_key: 'test-client-key',
      client_secret: 'test-client-secret',
      token: ACCESS,
    });
    expect(url).not.toContain(ACCESS);
  });

  it('maps revoke answers', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { error: 'invalid_token', error_description: 'x' })
    );
    expect(await revoker.revoke(ACCESS)).toBe('failed');
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    expect(await revoker.revoke(ACCESS)).toBe('failed');
    fetchMock.mockResolvedValueOnce(reply(200));
    expect(await revoker.revoke(ACCESS)).toBe('failed');
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await revoker.revoke(ACCESS)).toBe('failed');
  });
});

describe('results never hold a token', () => {
  it('for every outcome', async () => {
    const results: unknown[] = [];
    const revoker = PLATFORM_REVOKERS.tiktok;
    fetchMock.mockRejectedValue(new Error(`${USER_TOKEN} ${REFRESH} ${ACCESS}`));
    results.push(await revoker.prepare(tokens({ refreshToken: REFRESH })));
    results.push(await revoker.revoke(ACCESS));
    fetchMock.mockResolvedValue(reply(400, { error: 'invalid_grant', token: ACCESS }));
    results.push(await revoker.prepare(tokens({ refreshToken: REFRESH })));
    results.push(await revoker.revoke(ACCESS));
    fetchMock.mockResolvedValue(
      reply(200, { access_token: ACCESS, open_id: 'other-id' })
    );
    results.push(await revoker.prepare(tokens({ refreshToken: REFRESH })));
    results.forEach((result) => noSecretIn(result));
  });
});
