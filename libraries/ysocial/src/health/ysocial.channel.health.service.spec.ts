import { Logger } from '@nestjs/common';

// The real IntegrationManager loads every provider, some of them ESM-only.
// The tests hand the service its providers directly.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import {
  YSOCIAL_CHANNEL_PROBLEMS_KEY,
  YsocialChannelHealthService,
} from './ysocial.channel.health.service';
import { ChannelRow } from './channel.health';

// Invented channels and a fake token, which must never come back.
const TOKEN = 'EAAG-fake-token-for-tests';
const NOW = new Date('2026-10-27T06:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const row = (id: string, patch: Partial<ChannelRow> = {}): ChannelRow => ({
  id,
  organizationId: 'org-1',
  customerId: null,
  name: `Y Social ${id}`,
  providerIdentifier: 'facebook',
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  tokenExpiration: new Date(NOW.getTime() + 30 * DAY),
  updatedAt: new Date(NOW.getTime() - DAY),
  ...patch,
});

// A provider that records every property read. Every method except
// analytics throws.
const recordingProvider = (analytics: jest.Mock) => {
  const accessed: string[] = [];
  const provider = new Proxy({ analytics } as Record<string, unknown>, {
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
  return { provider, accessed };
};

const setup = (
  channels: ChannelRow[],
  providers: Record<string, unknown>,
  failedPosts: any[] = []
) => {
  const integrations = {
    getChannels: jest.fn().mockResolvedValue(channels),
    getChannelForPlatformCheck: jest.fn(async (id: string) => ({
      id,
      providerIdentifier: channels.find((c) => c.id === id)!.providerIdentifier,
      internalId: `page-${id}`,
      token: TOKEN,
    })),
  };
  const posts = { findFailedPosts: jest.fn().mockResolvedValue(failedPosts) };
  const manager = {
    getSocialIntegration: jest.fn((id: string) => providers[id]),
  };
  const service = new YsocialChannelHealthService(
    integrations as any,
    posts as any,
    manager as any
  );
  const saved: Record<string, string> = {};
  (service as any).store = {
    get: async (key: string) => saved[key],
    set: async (key: string, value: string) => (saved[key] = value),
  };
  return { service, integrations, posts, manager, saved };
};

let logs: jest.SpyInstance;
beforeEach(() => {
  logs = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('hourly channel check', () => {
  it('reads only the database, no platform call', async () => {
    const analytics = jest.fn();
    const { provider, accessed } = recordingProvider(analytics);
    const { service, manager, integrations } = setup(
      [row('int-1', { refreshNeeded: true }), row('int-2')],
      { facebook: provider }
    );

    const result = await service.checkChannels(NOW);

    expect(result.channels).toBe(2);
    expect(result.events.map((e) => [e.kind, e.subject.id])).toEqual([
      ['channel.disconnected', 'int-1'],
    ]);
    expect(manager.getSocialIntegration).not.toHaveBeenCalled();
    expect(integrations.getChannelForPlatformCheck).not.toHaveBeenCalled();
    expect(accessed).toEqual([]);
  });

  it('reports the way back in the next hour', async () => {
    const { service, integrations, saved } = setup(
      [row('int-1', { disabled: true })],
      {}
    );
    await service.checkChannels(NOW);
    expect(JSON.parse(saved[YSOCIAL_CHANNEL_PROBLEMS_KEY])).toHaveProperty(
      'int-1'
    );

    integrations.getChannels.mockResolvedValue([
      row('int-1', { updatedAt: new Date(NOW.getTime() + 1000) }),
    ]);
    const later = await service.checkChannels(
      new Date(NOW.getTime() + 3600_000)
    );
    expect(later.events.map((e) => e.kind)).toEqual(['channel.reconnected']);
    expect(JSON.parse(saved[YSOCIAL_CHANNEL_PROBLEMS_KEY])).toEqual({});
  });

  it('starts from scratch when the stored state is broken', async () => {
    const { service, saved } = setup([row('int-1', { disabled: true })], {});
    saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = '{not json';
    const result = await service.checkChannels(NOW);
    expect(result.events.map((e) => e.kind)).toEqual(['channel.disconnected']);
  });
});

describe('DailyHealth', () => {
  it('makes exactly one platform call per checkable channel, only analytics (QA 5)', async () => {
    const analytics = jest.fn().mockResolvedValue([{ label: 'Reach' }]);
    const { provider, accessed } = recordingProvider(analytics);
    const { service } = setup(
      [
        row('int-ok-1'),
        row('int-ok-2'),
        row('int-gone', { refreshNeeded: true }),
        row('int-expired', { tokenExpiration: new Date(NOW.getTime() - 1000) }),
        row('int-other', { providerIdentifier: 'no-such-provider' }),
      ],
      { facebook: provider }
    );

    const { summary } = await service.runDailyHealth(NOW);

    expect(analytics).toHaveBeenCalledTimes(2);
    expect(analytics).toHaveBeenCalledWith('page-int-ok-1', TOKEN, 1);
    expect(new Set(accessed)).toEqual(new Set(['analytics']));
    expect(summary).toMatchObject({
      channels: 5,
      platformCalls: 2,
      skipped: 3,
    });
    expect(logs).toHaveBeenCalledWith(
      'daily health: channels=5 platform calls=2 skipped=3'
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(TOKEN);
  });

  it('builds one event per finding and the summary', async () => {
    const analytics = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('Error validating access token: Session has expired')
      )
      .mockResolvedValueOnce([]);
    const expires = new Date(NOW.getTime() + 2 * DAY);
    const { service } = setup(
      [
        row('int-revoked'),
        row('int-expiring', { tokenExpiration: expires }),
        row('int-off', { disabled: true }),
      ],
      { facebook: { analytics } },
      [
        {
          id: 'post-err',
          organizationId: 'org-1',
          integrationId: 'int-off',
          publishDate: new Date('2026-10-25T09:00:00.000Z'),
          error: 'failed: https://graph.facebook.com/x?access_token=EAAGsecret',
          integration: { providerIdentifier: 'facebook', customerId: null },
        },
      ]
    );

    const { events, summary } = await service.runDailyHealth(NOW);

    expect(events.map((e) => [e.kind, e.subject.id])).toEqual([
      ['channel.auth_invalid', 'int-revoked'],
      ['channel.disconnected', 'int-off'],
      ['channel.token_expiring', 'int-expiring'],
      ['post.failed', 'post-err'],
      ['health.daily', 'postiz'],
    ]);
    expect(events[0].reason).toContain('Zugang ungültig');
    expect(events[3].id).toBe(
      `post.failed:post-err:${Date.parse('2026-10-25T09:00:00.000Z')}`
    );
    const summaryEvent = events[4];
    expect(summaryEvent.id).toBe('health.daily:postiz:2026-10-27');
    expect(summary).toEqual({
      day: '2026-10-27',
      channels: 3,
      platformCalls: 2,
      skipped: 1,
      disconnected: ['int-off'],
      authInvalid: ['int-revoked'],
      tokenExpiring: ['int-expiring'],
      unclear: [],
      failedPosts: ['post-err'],
    });
    expect(summaryEvent.data).toEqual(summary);
    const text = JSON.stringify(events);
    expect(text).not.toContain('EAAGsecret');
    expect(text).not.toContain(TOKEN);
  });

  it('lists failed calls without auth error as "unklar", without alarm', async () => {
    const { service } = setup([row('int-1')], {
      facebook: {
        analytics: jest
          .fn()
          .mockRejectedValue(
            new Error('(#4) Application request limit reached')
          ),
      },
    });
    const { events, summary } = await service.runDailyHealth(NOW);
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(summary.unclear).toEqual(['int-1']);
  });

  it('reads posts in ERROR of the last 7 days', async () => {
    const { service, posts } = setup([], {});
    await service.runDailyHealth(NOW);
    expect(posts.findFailedPosts).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 7 * DAY),
      NOW
    );
  });
});

describe('DailyHealth with the real Meta providers', () => {
  let fetchMock: jest.SpyInstance;
  const graph = (body: unknown) =>
    fetchMock.mockResolvedValue({ json: async () => body } as Response);

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  it('facebook: a revoked token means "Zugang ungültig"', async () => {
    graph({
      error: {
        message:
          'Error validating access token: The user has not authorized application 1234.',
        type: 'OAuthException',
        code: 190,
      },
    });
    const { service } = setup([row('int-1')], {
      facebook: new FacebookProvider(),
    });
    const { events } = await service.runDailyHealth(NOW);
    expect(events.map((e) => e.kind)).toEqual([
      'channel.auth_invalid',
      'health.daily',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/page-int-1/insights?'
    );
  });

  it('facebook: page insights mean "ok"', async () => {
    graph({
      data: [
        {
          name: 'page_post_engagements',
          values: [{ value: 1, end_time: '2026-10-26' }],
        },
      ],
    });
    const { service } = setup([row('int-1')], {
      facebook: new FacebookProvider(),
    });
    const { events, summary } = await service.runDailyHealth(NOW);
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(summary.unclear).toEqual([]);
  });

  it('instagram: an error answer is "unklar"', async () => {
    graph({ error: { message: 'Error validating access token', code: 190 } });
    const { service } = setup(
      [row('int-ig', { providerIdentifier: 'instagram' })],
      {
        instagram: new InstagramProvider(),
      }
    );
    const { summary } = await service.runDailyHealth(NOW);
    expect(summary.unclear).toEqual(['int-ig']);
    expect(summary.authInvalid).toEqual([]);
  });
});
