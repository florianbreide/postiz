import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LinkedinPageProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.page.provider';
import { LinkedinProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.provider';
import { NotEnoughScopes } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  YSOCIAL_LINKEDIN_PAGE_ADD,
  YSOCIAL_LINKEDIN_PAGE_DROP,
  ysocialLinkedinPageScopes,
  ysocialLinkedinUserinfo,
} from './linkedin.scopes';

// ysocial patch 7: the Postiz provider "linkedin-page" without openid and
// profile, member from /v2/me. LinkedIn is mocked, nothing leaves the process.

const ROOT = join(__dirname, '..', '..', '..', '..');

const EXPECTED_SCOPES = [
  'w_member_social',
  'r_basicprofile',
  'rw_organization_admin',
  'w_organization_social',
  'r_organization_social',
  'r_organization_social_feed',
  'w_organization_social_feed',
];

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response);

describe('LinkedIn page scopes (patch 7)', () => {
  const original = global.fetch;
  const env = { ...process.env };
  const accessToken = randomBytes(24).toString('hex');
  const refreshToken = randomBytes(24).toString('hex');
  let fetchMock: jest.Mock;

  const meBody = (overrides: Record<string, unknown> = {}) => ({
    id: 'FictionalId01',
    localizedFirstName: 'Erika',
    localizedLastName: 'Mustermann',
    profilePicture: {
      'displayImage~': {
        elements: [
          { identifiers: [{ identifier: 'https://img.example.test/small' }] },
          { identifiers: [{ identifier: 'https://img.example.test/large' }] },
        ],
      },
    },
    ...overrides,
  });

  /** LinkedIn answers; `granted` is the scope list of the token response. */
  const mockLinkedin = (granted: string[] = EXPECTED_SCOPES) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/v2/accessToken')) {
        return json({
          access_token: accessToken,
          expires_in: 5184000,
          refresh_token: refreshToken,
          scope: granted.join(','),
        });
      }
      if (url.includes('/v2/me?projection=')) {
        return json(meBody());
      }
      if (url === 'https://api.linkedin.com/v2/me') {
        return json({ id: 'FictionalId01', vanityName: 'erfundene-seite' });
      }
      throw new Error(`unexpected request: ${url}`);
    });
  };
  const urls = () => fetchMock.mock.calls.map(([url]) => url as string);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    process.env.LINKEDIN_CLIENT_ID = 'fictional-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'fictional-client-secret';
    process.env.FRONTEND_URL = 'https://app.example.test';
  });

  afterEach(() => {
    global.fetch = original;
    process.env = { ...env };
  });

  describe('guard for patch 7 and upstream syncs', () => {
    it('has the identifier "linkedin-page"', () => {
      expect(new LinkedinPageProvider().identifier).toBe('linkedin-page');
    });

    it('asks for exactly the expected scopes, each once, without openid and profile', () => {
      const { scopes } = new LinkedinPageProvider();
      expect([...scopes].sort()).toEqual([...EXPECTED_SCOPES].sort());
      expect(new Set(scopes).size).toBe(scopes.length);
      expect(scopes).not.toContain('openid');
      expect(scopes).not.toContain('profile');
    });

    it('keeps the patch in the source of the Postiz file', () => {
      const source = readFileSync(
        join(
          ROOT,
          'libraries',
          'nestjs-libraries',
          'src',
          'integrations',
          'social',
          'linkedin.page.provider.ts'
        ),
        'utf8'
      );
      expect(source).toContain('ysocialLinkedinPageScopes(');
      expect(source).toContain('ysocial patch 7');
      // the comments of the patch name /v2/userinfo, the request must be gone
      expect(source).not.toContain('api.linkedin.com/v2/userinfo');
    });

    it('leaves openid and profile on the personal provider "linkedin"', () => {
      const provider = new LinkedinProvider();
      expect(provider.identifier).toBe('linkedin');
      expect(provider.scopes).toContain('openid');
      expect(provider.scopes).toContain('profile');
    });
  });

  describe('generateAuthUrl', () => {
    it('asks for both feed scopes and neither openid nor profile', async () => {
      const { url } = await new LinkedinPageProvider().generateAuthUrl();
      const requested = new URL(url).searchParams.get('scope')!.split(' ');
      expect(requested).toEqual(
        expect.arrayContaining(YSOCIAL_LINKEDIN_PAGE_ADD)
      );
      expect(requested).not.toContain('openid');
      expect(requested).not.toContain('profile');
    });
  });

  describe('authenticate', () => {
    const params = () => ({
      code: randomBytes(8).toString('hex'),
      codeVerifier: 'x',
      refresh: '',
    });

    it('connects without openid, with id and name from /v2/me', async () => {
      mockLinkedin();
      const result = await new LinkedinPageProvider().authenticate(params());
      expect(result).not.toBeInstanceOf(String);
      expect(result).toMatchObject({
        id: 'linkedin-page_FictionalId01',
        name: 'Erika Mustermann',
        picture: 'https://img.example.test/large',
        username: 'erfundene-seite',
        accessToken,
        refreshToken,
        expiresIn: 5184000,
      });
    });

    it('never calls /v2/userinfo and sends the token on every LinkedIn request', async () => {
      mockLinkedin();
      await new LinkedinPageProvider().authenticate(params());
      expect(urls().some((url) => url.includes('/v2/userinfo'))).toBe(false);
      const api = fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith('https://api.linkedin.com/')
      );
      expect(api.length).toBeGreaterThanOrEqual(2);
      for (const [, init] of api) {
        expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);
      }
    });

    it.each(EXPECTED_SCOPES.map((scope) => [scope]))(
      'refuses with NotEnoughScopes when "%s" is missing',
      async (scope) => {
        mockLinkedin(EXPECTED_SCOPES.filter((s) => s !== scope));
        await expect(
          new LinkedinPageProvider().authenticate(params())
        ).rejects.toBeInstanceOf(NotEnoughScopes);
        expect(urls().some((url) => url.includes('/v2/me'))).toBe(false);
      }
    );
  });

  describe('refreshToken', () => {
    it('maps the member from /v2/me and does not call /v2/userinfo', async () => {
      mockLinkedin();
      const result = await new LinkedinPageProvider().refreshToken(
        randomBytes(8).toString('hex')
      );
      expect(result).toMatchObject({
        id: 'FictionalId01',
        name: 'Erika Mustermann',
        picture: 'https://img.example.test/large',
        username: 'erfundene-seite',
        accessToken,
        refreshToken: expect.any(String),
        expiresIn: 5184000,
      });
      expect(urls().some((url) => url.includes('/v2/userinfo'))).toBe(false);
    });
  });

  describe('ysocialLinkedinUserinfo', () => {
    const answer = (body: unknown) => fetchMock.mockResolvedValue(json(body));

    it('asks /v2/me with the projection and the bearer token', async () => {
      answer(meBody());
      await ysocialLinkedinUserinfo(accessToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('https://api.linkedin.com/v2/me?projection=');
      expect(url).toContain('localizedFirstName');
      expect(url).toContain('displayImage~');
      expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);
    });

    it('returns sub, name and the last picture', async () => {
      answer(meBody());
      expect(await ysocialLinkedinUserinfo(accessToken)).toEqual({
        sub: 'FictionalId01',
        name: 'Erika Mustermann',
        picture: 'https://img.example.test/large',
      });
    });

    it('has no picture field without a picture', async () => {
      answer(meBody({ profilePicture: undefined }));
      const result = await ysocialLinkedinUserinfo(accessToken);
      expect(result).not.toHaveProperty('picture');
    });

    it('has no picture for empty elements', async () => {
      answer(meBody({ profilePicture: { 'displayImage~': { elements: [] } } }));
      const result = await ysocialLinkedinUserinfo(accessToken);
      expect(result).not.toHaveProperty('picture');
    });

    it('has no trailing space with only a first name', async () => {
      answer(meBody({ localizedLastName: undefined }));
      const result = await ysocialLinkedinUserinfo(accessToken);
      expect(result.name).toBe('Erika');
    });
  });

  describe('ysocialLinkedinPageScopes', () => {
    it('does not duplicate an ADD scope the list already holds', () => {
      const result = ysocialLinkedinPageScopes([
        'a',
        'r_organization_social_feed',
      ]);
      expect(
        result.filter((s) => s === 'r_organization_social_feed')
      ).toHaveLength(1);
      expect(result).toContain('w_organization_social_feed');
    });

    it('puts the Postiz list without DROP first, then ADD', () => {
      expect(
        ysocialLinkedinPageScopes(['openid', 'a', 'profile', 'b'])
      ).toEqual(['a', 'b', ...YSOCIAL_LINKEDIN_PAGE_ADD]);
    });

    it('does not change its input', () => {
      const input = ['openid', 'a', 'profile'];
      ysocialLinkedinPageScopes(input);
      expect(input).toEqual(['openid', 'a', 'profile']);
    });

    it('drops exactly openid and profile', () => {
      expect(YSOCIAL_LINKEDIN_PAGE_DROP).toEqual(['openid', 'profile']);
    });
  });
});
