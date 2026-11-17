import { randomBytes } from 'crypto';
import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';
import { NotEnoughScopes } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { YSOCIAL_META_SCOPES } from './meta.scopes';

// ysocial patches 4 and 5: the Postiz providers "facebook" and "instagram"
// ask for the extra Meta scopes. Meta is mocked, nothing leaves the process.

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body } as unknown as Response);

const providers = [
  {
    identifier: 'facebook',
    own: 'pages_show_list',
    make: () => new FacebookProvider(),
  },
  {
    identifier: 'instagram',
    own: 'instagram_basic',
    make: () => new InstagramProvider(),
  },
] as const;

describe('YSOCIAL_META_SCOPES', () => {
  const original = global.fetch;
  const env = { ...process.env };
  const accessToken = randomBytes(24).toString('hex');
  let fetchMock: jest.Mock;

  /** Meta answers: `declined` is the one permission the person refused. */
  const mockMeta = (scopes: string[], declined?: string) => {
    fetchMock.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith('/me/permissions')) {
        return json({
          data: scopes.map((permission) => ({
            permission,
            status: permission === declined ? 'declined' : 'granted',
          })),
        });
      }
      if (pathname.endsWith('/me')) {
        return json({
          id: '1000000000001',
          name: 'Erfundene Seite',
          picture: {},
        });
      }
      return json({ access_token: accessToken });
    });
  };
  const paths = () =>
    fetchMock.mock.calls.map(([url]) => new URL(url as string).pathname);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    process.env.FACEBOOK_APP_ID = '123456789012345';
    process.env.FRONTEND_URL = 'https://app.example.test';
  });

  afterEach(() => {
    global.fetch = original;
    process.env = { ...env };
  });

  it('holds pages_manage_metadata for the webhooks', () => {
    expect(YSOCIAL_META_SCOPES).toContain('pages_manage_metadata');
  });

  describe.each(providers)(
    'provider "$identifier"',
    ({ identifier, own, make }) => {
      it('has the expected identifier', () => {
        expect(make().identifier).toBe(identifier);
      });

      it('lists every inbox scope exactly once and keeps its own scopes', () => {
        const { scopes } = make();
        for (const scope of YSOCIAL_META_SCOPES) {
          expect(scopes.filter((s) => s === scope)).toHaveLength(1);
        }
        expect(scopes).toContain(own);
      });

      it('asks for every inbox scope in the login URL', async () => {
        const { url } = await make().generateAuthUrl();
        const requested = new URL(url).searchParams.get('scope')!.split(',');
        for (const scope of YSOCIAL_META_SCOPES) {
          expect(requested).toContain(scope);
        }
      });

      it('connects when Meta grants every scope', async () => {
        const provider = make();
        mockMeta(provider.scopes);
        const result = await provider.authenticate({
          code: randomBytes(8).toString('hex'),
          codeVerifier: 'x',
          refresh: '',
        });
        expect(result.id).toBe('1000000000001');
        expect(result.name).toBe('Erfundene Seite');
      });

      it.each(YSOCIAL_META_SCOPES.map((scope) => [scope]))(
        'refuses with NotEnoughScopes when "%s" is declined',
        async (scope) => {
          const provider = make();
          mockMeta(provider.scopes, scope);
          await expect(
            provider.authenticate({
              code: randomBytes(8).toString('hex'),
              codeVerifier: 'x',
              refresh: '',
            })
          ).rejects.toBeInstanceOf(NotEnoughScopes);
          expect(paths().some((p) => p.endsWith('/me/permissions'))).toBe(true);
          expect(paths().some((p) => p.endsWith('/me'))).toBe(false);
        }
      );
    }
  );

  it('does not add any inbox scope to "instagram-standalone"', () => {
    const provider = new InstagramStandaloneProvider();
    expect(provider.identifier).toBe('instagram-standalone');
    for (const scope of YSOCIAL_META_SCOPES) {
      expect(provider.scopes).not.toContain(scope);
    }
  });
});
