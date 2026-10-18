import { Logger } from '@nestjs/common';

// The real IntegrationManager loads every provider, some of them ESM-only.
// The tests hand the service its providers directly.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { YsocialPostVerificationService } from './ysocial.post.verification.service';

// Invented data. The token is a fake, it must never come back from the
// service.
const TOKEN = 'EAAG-fake-page-token-for-tests';
const NOW = new Date('2026-10-26T09:05:00.000Z');

const platformPost = (patch: any = {}) => ({
  id: 'post-1',
  state: 'PUBLISHED',
  releaseId: '1234_5678',
  settings: '{}',
  ...patch,
  integration: {
    providerIdentifier: 'facebook',
    internalId: 'page-1',
    token: TOKEN,
    tokenExpiration: new Date('2026-12-01T00:00:00.000Z'),
    disabled: false,
    refreshNeeded: false,
    inBetweenSteps: false,
    deletedAt: null,
    ...(patch.integration || {}),
  },
});

const repository = (post: any) => ({
  findPostsToVerify: jest
    .fn()
    .mockResolvedValue([{ id: 'post-1' }, { id: 'post-2' }]),
  getPostForVerification: jest.fn(),
  getPostForPlatformCheck: jest.fn().mockResolvedValue(post),
});

// A provider that records every property read. Every method except
// postAnalytics throws, so a test fails if anything else gets called.
const recordingProvider = (result: unknown) => {
  const accessed: string[] = [];
  const target: Record<string, unknown> = {
    postAnalytics: jest.fn().mockResolvedValue(result),
  };
  const provider = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string') {
        accessed.push(prop);
      }
      if (prop in obj) {
        return obj[prop as string];
      }
      return () => {
        throw new Error(`provider.${String(prop)} must not be called`);
      };
    },
  });
  return {
    provider,
    accessed,
    postAnalytics: target.postAnalytics as jest.Mock,
  };
};

const manager = (provider: unknown) =>
  ({ getSocialIntegration: jest.fn().mockReturnValue(provider) } as any);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('checkOnPlatform with a mocked provider', () => {
  it('calls postAnalytics and nothing else (QA 4)', async () => {
    const { provider, accessed, postAnalytics } = recordingProvider([
      { label: 'Impressions', percentageChange: 0, data: [] },
    ]);
    const service = new YsocialPostVerificationService(
      repository(platformPost()) as any,
      manager(provider)
    );
    const logs = jest.spyOn(Logger.prototype, 'log');

    const result = await service.checkOnPlatform('post-1', NOW);

    expect(result).toEqual({ result: 'found' });
    expect(accessed).toEqual(['postAnalytics', 'postAnalytics']);
    expect(postAnalytics).toHaveBeenCalledTimes(1);
    expect(postAnalytics).toHaveBeenCalledWith('page-1', TOKEN, '1234_5678', 7);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(logs).toHaveBeenCalledWith(
      'provider call postAnalytics provider=facebook post=post-1 result=found'
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(TOKEN);
  });

  it('reads an empty list as "not found"', async () => {
    const { provider } = recordingProvider([]);
    const service = new YsocialPostVerificationService(
      repository(platformPost()) as any,
      manager(provider)
    );
    expect(await service.checkOnPlatform('post-1', NOW)).toEqual({
      result: 'not_found',
    });
  });

  it.each([
    [
      'a provider without rule',
      platformPost({ integration: { providerIdentifier: 'linkedin-page' } }),
      'linkedin-page',
    ],
    ['no platform id', platformPost({ releaseId: null }), 'ID des Posts'],
    [
      'the id "missing"',
      platformPost({ releaseId: 'missing' }),
      'ID des Posts',
    ],
    [
      'a disconnected channel',
      platformPost({ integration: { refreshNeeded: true } }),
      'getrennt',
    ],
    [
      'a disabled channel',
      platformPost({ integration: { disabled: true } }),
      'getrennt',
    ],
    [
      'an expired token',
      platformPost({
        integration: { tokenExpiration: new Date('2026-10-01T00:00:00.000Z') },
      }),
      'abgelaufen',
    ],
    ['a Facebook reel', platformPost({ releaseId: '987654321' }), 'Reel'],
    [
      'an Instagram story',
      platformPost({
        settings: '{"post_type":"story"}',
        integration: { providerIdentifier: 'instagram' },
      }),
      'Story',
    ],
    ['a deleted post', null, 'nicht mehr in Postiz'],
  ])(
    'reports %s as "nicht prüfbar" without a platform call',
    async (_name, post, reason) => {
      const { provider, postAnalytics } = recordingProvider([{}]);
      const service = new YsocialPostVerificationService(
        repository(post) as any,
        manager(provider)
      );
      const result = await service.checkOnPlatform('post-1', NOW);
      expect(result.result).toBe('unverifiable');
      expect((result as any).reason).toContain(reason);
      expect(postAnalytics).not.toHaveBeenCalled();
    }
  );

  it('passes provider errors on, so Temporal retries', async () => {
    const service = new YsocialPostVerificationService(
      repository(platformPost()) as any,
      manager({
        postAnalytics: jest.fn().mockRejectedValue(new Error('timeout')),
      })
    );
    await expect(service.checkOnPlatform('post-1', NOW)).rejects.toThrow(
      'timeout'
    );
  });
});

describe('checkOnPlatform with the real Facebook and Instagram providers', () => {
  let fetchMock: jest.SpyInstance;

  const graph = (body: unknown) =>
    fetchMock.mockResolvedValue({ json: async () => body } as Response);

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const facebook = () =>
    new YsocialPostVerificationService(
      repository(platformPost()) as any,
      manager(new FacebookProvider())
    );

  const instagram = () =>
    new YsocialPostVerificationService(
      repository(
        platformPost({
          releaseId: '17900000000000001',
          integration: { providerIdentifier: 'instagram' },
        })
      ) as any,
      manager(new InstagramProvider())
    );

  it('facebook: insights of the post mean "found"', async () => {
    graph({
      data: [
        {
          name: 'post_reactions_by_type_total',
          values: [{ value: { like: 0 } }],
        },
      ],
    });
    expect(await facebook().checkOnPlatform('post-1', NOW)).toEqual({
      result: 'found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(
      /^https:\/\/graph\.facebook\.com\/v[\d.]+\/1234_5678\/insights\?/
    );
  });

  it('facebook: an unknown post means "not found"', async () => {
    graph({
      error: {
        message:
          'Unsupported get request. Object with ID 1234_5678 does not exist',
        code: 100,
      },
    });
    expect(await facebook().checkOnPlatform('post-1', NOW)).toEqual({
      result: 'not_found',
    });
  });

  it('facebook: a revoked token also means "not found"', async () => {
    graph({ error: { message: 'Error validating access token', code: 190 } });
    expect(await facebook().checkOnPlatform('post-1', NOW)).toEqual({
      result: 'not_found',
    });
  });

  it('instagram: media insights mean "found", an error "not found"', async () => {
    graph({ data: [{ name: 'views', values: [{ value: 3 }] }] });
    expect(await instagram().checkOnPlatform('post-1', NOW)).toEqual({
      result: 'found',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/17900000000000001/insights?'
    );

    graph({ error: { message: 'Media ID is not available', code: 100 } });
    expect(await instagram().checkOnPlatform('post-1', NOW)).toEqual({
      result: 'not_found',
    });
  });
});

describe('loadSnapshot', () => {
  it('maps the post without token and with a sanitized error', async () => {
    const repo = repository(null);
    repo.getPostForVerification.mockResolvedValue({
      id: 'post-1',
      organizationId: 'org-1',
      integrationId: 'int-1',
      state: 'ERROR',
      publishDate: new Date('2026-10-26T09:00:00.000Z'),
      deletedAt: null,
      releaseURL: null,
      error:
        'request failed: https://graph.facebook.com/x?access_token=EAAGsecret',
      integration: {
        providerIdentifier: 'facebook',
        customerId: null,
        disabled: false,
        refreshNeeded: true,
        inBetweenSteps: false,
        deletedAt: null,
      },
    });
    const service = new YsocialPostVerificationService(
      repo as any,
      manager({})
    );
    const snapshot = await service.loadSnapshot('post-1');
    expect(snapshot).toEqual({
      id: 'post-1',
      organizationId: 'org-1',
      integrationId: 'int-1',
      state: 'ERROR',
      publishDate: '2026-10-26T09:00:00.000Z',
      deleted: false,
      releaseURL: null,
      error: 'request failed: https://graph.facebook.com/x?access_token=***',
      integration: {
        providerIdentifier: 'facebook',
        customerId: null,
        disconnected: true,
      },
    });
  });

  it('returns null for an unknown post', async () => {
    const repo = repository(null);
    repo.getPostForVerification.mockResolvedValue(null);
    const service = new YsocialPostVerificationService(
      repo as any,
      manager({})
    );
    expect(await service.loadSnapshot('post-x')).toBeNull();
  });
});

describe('findPostIdsToVerify', () => {
  it('reads the last 60 minutes by default and at most 7 days', async () => {
    const repo = repository(null);
    const service = new YsocialPostVerificationService(
      repo as any,
      manager({})
    );
    expect(await service.findPostIdsToVerify(NOW)).toEqual([
      'post-1',
      'post-2',
    ]);
    expect(repo.findPostsToVerify).toHaveBeenLastCalledWith(
      new Date('2026-10-26T08:05:00.000Z'),
      NOW
    );
    await service.findPostIdsToVerify(NOW, 100_000);
    expect(repo.findPostsToVerify).toHaveBeenLastCalledWith(
      new Date('2026-10-19T09:05:00.000Z'),
      NOW
    );
  });
});
