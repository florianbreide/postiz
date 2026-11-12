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
import {
  initialVerificationMemory,
  nextVerificationStep,
  PostVerificationSnapshot,
} from '../verification/post.verification';

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
  // A fixed clock: no test depends on how long it really runs.
  (service as any).clock = () => 0;
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
          updatedAt: new Date('2026-10-25T09:00:30.000Z'),
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
      `post.failed:post-err:${Date.parse(
        '2026-10-25T09:00:00.000Z'
      )}-${Date.parse('2026-10-25T09:00:30.000Z')}`
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

  describe('ids of post.failed', () => {
    const failedPost = (updatedAt: string) => ({
      id: 'post-err',
      organizationId: 'org-1',
      integrationId: 'int-1',
      publishDate: new Date('2026-10-25T09:00:00.000Z'),
      updatedAt: new Date(updatedAt),
      error: 'failed',
      integration: {
        providerIdentifier: 'facebook',
        customerId: null as string | null,
      },
    });
    const failedIds = async (updatedAt: string, now: Date) => {
      const { service } = setup([], {}, [failedPost(updatedAt)]);
      const { events } = await service.runDailyHealth(now);
      return events.filter((e) => e.kind === 'post.failed').map((e) => e.id);
    };

    it('is the same on two days for an unchanged row', async () => {
      const a = await failedIds('2026-10-25T09:00:30.000Z', NOW);
      const b = await failedIds(
        '2026-10-25T09:00:30.000Z',
        new Date(NOW.getTime() + DAY)
      );
      expect(a).toHaveLength(1);
      expect(b).toEqual(a);
    });

    it('is new for a row with a new updatedAt', async () => {
      const a = await failedIds('2026-10-25T09:00:30.000Z', NOW);
      const b = await failedIds('2026-10-26T10:00:00.000Z', NOW);
      expect(b).toHaveLength(1);
      expect(b).not.toEqual(a);
    });

    it('is the id PostVerification forms for the same post', async () => {
      const snapshot: PostVerificationSnapshot = {
        id: 'post-err',
        organizationId: 'org-1',
        integrationId: 'int-1',
        state: 'ERROR',
        publishDate: '2026-10-25T09:00:00.000Z',
        deleted: false,
        releaseURL: null,
        error: 'failed',
        updatedAt: '2026-10-25T09:00:30.000Z',
        integration: {
          providerIdentifier: 'facebook',
          customerId: null,
          disconnected: false,
        },
      };
      const verification = nextVerificationStep({
        postId: 'post-err',
        snapshot,
        now: Date.parse('2026-10-25T09:01:00.000Z'),
        memory: initialVerificationMemory(),
        failedPerAttempt: true,
      });
      const daily = await failedIds(snapshot.updatedAt, NOW);
      expect(verification.events.map((e) => e.id)).toEqual(daily);
    });
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

describe('DailyHealth when channels change during the platform calls', () => {
  const AUTH_ERROR = new Error(
    'Error validating access token: Session has expired'
  );
  const changedAt = new Date(NOW.getTime() + 1000);

  // The first read of getChannels gives "before", the second "after".
  // runDailyHealth and prepareDailyHealth take the same path.
  const run = async (
    before: ChannelRow[],
    after: ChannelRow[],
    analytics: jest.Mock,
    previous: Record<string, unknown> = {},
    elapsedMs = 0
  ) => {
    const ctx = setup(before, { facebook: { analytics } });
    // Read at the start of the run and after the platform calls.
    const times = [0, elapsedMs];
    (ctx.service as any).clock = () => times.shift() ?? elapsedMs;
    ctx.integrations.getChannels
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify(previous);
    const result = await ctx.service.runDailyHealth(NOW);
    return {
      ...ctx,
      ...result,
      state: JSON.parse(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]),
    };
  };

  it('does not report a false reconnect when the hourly check flagged the channel', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const disconnected = {
      'int-x': {
        kind: 'channel.disconnected',
        updatedAt: row('int-x').updatedAt!.getTime(),
        since: '2026-10-26T06:00:00.000Z',
      },
    };
    const { events, state } = await run(
      [row('int-x')],
      [row('int-x', { refreshNeeded: true, updatedAt: changedAt })],
      analytics,
      disconnected
    );
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(state['int-x']).toMatchObject({ kind: 'channel.disconnected' });
  });

  it('drops an auth_invalid result of a token that was replaced meanwhile', async () => {
    const analytics = jest.fn().mockRejectedValue(AUTH_ERROR);
    const { events, summary } = await run(
      [row('int-x')],
      [row('int-x', { updatedAt: changedAt })],
      analytics
    );
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(summary.authInvalid).toEqual([]);
  });

  it('keeps an auth_invalid result of an unchanged channel', async () => {
    const analytics = jest.fn().mockRejectedValue(AUTH_ERROR);
    const { events, summary } = await run(
      [row('int-x')],
      [row('int-x')],
      analytics
    );
    expect(events.map((e) => [e.kind, e.subject.id])).toEqual([
      ['channel.auth_invalid', 'int-x'],
      ['health.daily', 'postiz'],
    ]);
    expect(summary.authInvalid).toEqual(['int-x']);
  });

  it('keeps an ok result of an unchanged channel', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const invalid = {
      'int-x': {
        kind: 'channel.auth_invalid',
        updatedAt: row('int-x').updatedAt!.getTime(),
        since: '2026-10-26T06:00:00.000Z',
      },
    };
    const same = await run([row('int-x')], [row('int-x')], analytics, invalid);
    expect(same.events.map((e) => e.kind)).toEqual([
      'channel.reconnected',
      'health.daily',
    ]);
  });

  it('reports a channel deleted during the loop as removed', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { events, state } = await run([row('int-gone')], [], analytics, {
      'int-gone': {
        kind: 'channel.disconnected',
        updatedAt: 1,
        since: '2026-10-26T06:00:00.000Z',
      },
    });
    expect(events.map((e) => [e.kind, e.subject.id])).toEqual([
      ['channel.removed', 'int-gone'],
      ['health.daily', 'postiz'],
    ]);
    expect(state).toEqual({});
  });

  it('gives a channel that appears during the loop no platform call and no result', async () => {
    const analytics = jest.fn().mockRejectedValue(AUTH_ERROR);
    const { events, summary } = await run(
      [row('int-old')],
      [row('int-old', { updatedAt: changedAt }), row('int-new')],
      analytics
    );
    expect(analytics).toHaveBeenCalledTimes(1);
    expect(analytics).toHaveBeenCalledWith('page-int-old', TOKEN, 1);
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(summary).toMatchObject({ channels: 2, authInvalid: [] });
  });

  it('does not warn about a token that was renewed meanwhile', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { events, summary } = await run(
      [row('int-x', { tokenExpiration: new Date(NOW.getTime() + 3 * DAY) })],
      [
        row('int-x', {
          tokenExpiration: new Date(NOW.getTime() + 60 * DAY),
          updatedAt: changedAt,
        }),
      ],
      analytics
    );
    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(summary.tokenExpiring).toEqual([]);
  });

  it('warns about a token that expires only in the second read', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { events } = await run(
      [row('int-x')],
      [
        row('int-x', {
          tokenExpiration: new Date(NOW.getTime() + 3 * DAY),
          updatedAt: changedAt,
        }),
      ],
      analytics
    );
    expect(events.map((e) => e.kind)).toEqual([
      'channel.token_expiring',
      'health.daily',
    ]);
  });

  it('skips by the first read: a channel flagged only in the second read still gets its call', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    await run(
      [row('int-x')],
      [row('int-x', { refreshNeeded: true, updatedAt: changedAt })],
      analytics
    );
    expect(analytics).toHaveBeenCalledTimes(1);
  });

  describe('time of the comparison', () => {
    const LATER = new Date(NOW.getTime() + 20 * 60_000);
    const MIN = 60_000;

    it('stamps a new disconnect with the time of the comparison', async () => {
      const analytics = jest.fn().mockResolvedValue([]);
      const { events } = await run(
        [row('int-x')],
        [row('int-x', { refreshNeeded: true, updatedAt: changedAt })],
        analytics,
        {},
        20 * MIN
      );
      const disconnected = events.find(
        (e) => e.kind === 'channel.disconnected'
      )!;
      expect(disconnected.occurredAt).toBe(LATER.toISOString());
      expect(Date.parse(disconnected.occurredAt)).toBeGreaterThan(
        NOW.getTime() + 15 * MIN
      );
    });

    it('stamps auth_invalid, since and its id with that time', async () => {
      const analytics = jest.fn().mockRejectedValue(AUTH_ERROR);
      const { events, state } = await run(
        [row('int-x')],
        [row('int-x')],
        analytics,
        {},
        20 * MIN
      );
      const invalid = events.find((e) => e.kind === 'channel.auth_invalid')!;
      expect(invalid.occurredAt).toBe(LATER.toISOString());
      expect(invalid.id).toContain(
        `${row('int-x').updatedAt!.getTime()}-${LATER.getTime()}`
      );
      expect(state['int-x'].since).toBe(LATER.toISOString());
    });

    it('keeps health.daily and token_expiring at the start of the run', async () => {
      const analytics = jest.fn().mockResolvedValue([]);
      const expiring = new Date(NOW.getTime() + 3 * DAY);
      const { events, summary } = await run(
        [row('int-x', { tokenExpiration: expiring })],
        [row('int-x', { tokenExpiration: expiring })],
        analytics,
        {},
        20 * MIN
      );
      const daily = events.find((e) => e.kind === 'health.daily')!;
      const warning = events.find((e) => e.kind === 'channel.token_expiring')!;
      expect(daily.occurredAt).toBe(NOW.toISOString());
      expect(warning.occurredAt).toBe(NOW.toISOString());
      expect(summary.day).toBe('2026-10-27');
    });

    it('does not let a clock that runs backwards move the time before the start', async () => {
      const analytics = jest.fn().mockRejectedValue(AUTH_ERROR);
      const { events } = await run(
        [row('int-x')],
        [row('int-x')],
        analytics,
        {},
        -5 * MIN
      );
      expect(
        events.find((e) => e.kind === 'channel.auth_invalid')!.occurredAt
      ).toBe(NOW.toISOString());
    });
  });

  describe('unclear', () => {
    const unclearCall = () =>
      jest.fn().mockRejectedValue(new Error('(#4) Application request limit'));

    it('lists an unchanged channel', async () => {
      const { summary } = await run(
        [row('int-x')],
        [row('int-x')],
        unclearCall()
      );
      expect(summary.unclear).toEqual(['int-x']);
    });

    it('leaves out a channel that is gone in the second read', async () => {
      const { summary } = await run([row('int-x')], [], unclearCall());
      expect(summary.unclear).toEqual([]);
    });

    it('leaves out a channel with a new updatedAt', async () => {
      const { summary } = await run(
        [row('int-x')],
        [row('int-x', { updatedAt: changedAt })],
        unclearCall()
      );
      expect(summary.unclear).toEqual([]);
    });
  });

  it('prepareDailyHealth leaves the disconnect of the hourly check alone', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const before = [row('int-x')];
    const after = [row('int-x', { refreshNeeded: true, updatedAt: changedAt })];
    const ctx = setup(before, { facebook: { analytics } });
    ctx.integrations.getChannels
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify({
      'int-x': {
        kind: 'channel.disconnected',
        updatedAt: before[0].updatedAt!.getTime(),
        since: '2026-10-26T06:00:00.000Z',
      },
    });

    const { events, changes } = await ctx.service.prepareDailyHealth(NOW);

    expect(events.map((e) => e.kind)).toEqual(['health.daily']);
    expect(changes).toEqual({});
  });

  it('reads the channels twice, both times before Redis', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const ctx = setup([row('int-x')], { facebook: { analytics } });
    const redisGet = jest.fn(async () => undefined);
    (ctx.service as any).store.get = redisGet;

    await ctx.service.prepareDailyHealth(NOW);

    expect(ctx.integrations.getChannels).toHaveBeenCalledTimes(2);
    const reads = ctx.integrations.getChannels.mock.invocationCallOrder;
    expect(redisGet).toHaveBeenCalled();
    expect(Math.max(...reads)).toBeLessThan(
      redisGet.mock.invocationCallOrder[0]
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

describe('DailyHealth with the test switch (PR 19)', () => {
  const ENVS = ['YSOCIAL_TEST_ROUTES', 'YSOCIAL_TEST_INTEGRATIONS'];
  const savedEnv = ENVS.map((name) => process.env[name]);
  const KEY = 'ysocial:test:invalid-token:int-1';
  // What YsocialTestSwitchService stores: the switch is on until "until".
  const active = () =>
    JSON.stringify({
      since: '2026-10-27T05:50:00.000Z',
      until: '2026-10-27T06:20:00.000Z',
    });

  beforeEach(() => {
    process.env.YSOCIAL_TEST_ROUTES = 'true';
    process.env.YSOCIAL_TEST_INTEGRATIONS = 'int-0, int-1';
  });
  afterEach(() => {
    ENVS.forEach((name, i) =>
      savedEnv[i] === undefined
        ? delete process.env[name]
        : (process.env[name] = savedEnv[i])
    );
  });

  it('sends the invalid token and reports "Zugang ungültig"', async () => {
    // A RefreshToken failure, as the provider throws it for a bad token.
    const { ApplicationFailure } = jest.requireActual('@temporalio/common');
    const analytics = jest
      .fn()
      .mockRejectedValue(
        ApplicationFailure.create({ message: 'x', type: 'refresh_token' })
      );
    const { service, saved } = setup([row('int-1')], {
      facebook: { analytics },
    });
    saved[KEY] = active();

    const { events } = await service.runDailyHealth(NOW);

    expect(analytics).toHaveBeenCalledWith(
      'page-int-1',
      'ysocial-test-invalid-token',
      1
    );
    expect(events.map((e) => [e.kind, e.subject.id])).toEqual([
      ['channel.auth_invalid', 'int-1'],
      ['health.daily', 'postiz'],
    ]);
    const text = JSON.stringify(logs.mock.calls);
    expect(text).toContain('test=invalid-token');
    expect(text).not.toContain(TOKEN);
  });

  it('keeps the stored token without the key in the store', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { service } = setup([row('int-1')], { facebook: { analytics } });
    await service.runDailyHealth(NOW);
    expect(analytics).toHaveBeenCalledWith('page-int-1', TOKEN, 1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('test=');
  });

  it.each([
    [
      'YSOCIAL_TEST_ROUTES is missing',
      () => delete process.env.YSOCIAL_TEST_ROUTES,
    ],
    [
      'YSOCIAL_TEST_ROUTES is not "true"',
      () => (process.env.YSOCIAL_TEST_ROUTES = 'false'),
    ],
    [
      'the channel is not listed',
      () => (process.env.YSOCIAL_TEST_INTEGRATIONS = 'int-0'),
    ],
    ['the list is missing', () => delete process.env.YSOCIAL_TEST_INTEGRATIONS],
  ])(
    'keeps the stored token when %s, although the key is set',
    async (_n, change) => {
      change();
      const analytics = jest.fn().mockResolvedValue([]);
      const { service, saved } = setup([row('int-1')], {
        facebook: { analytics },
      });
      saved[KEY] = active();
      await service.runDailyHealth(NOW);
      expect(analytics).toHaveBeenCalledWith('page-int-1', TOKEN, 1);
      expect(JSON.stringify(logs.mock.calls)).not.toContain('test=');
    }
  );

  it('keeps the stored token when "until" is before NOW (TTL not enforced)', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { service, saved } = setup([row('int-1')], {
      facebook: { analytics },
    });
    saved[KEY] = JSON.stringify({
      since: '2026-10-27T04:50:00.000Z',
      until: '2026-10-27T05:20:00.000Z',
    });
    await service.runDailyHealth(NOW);
    expect(analytics).toHaveBeenCalledWith('page-int-1', TOKEN, 1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('test=');
  });

  it('keeps the stored token when the stored value has no "until"', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { service, saved } = setup([row('int-1')], {
      facebook: { analytics },
    });
    saved[KEY] = '1';
    await service.runDailyHealth(NOW);
    expect(analytics).toHaveBeenCalledWith('page-int-1', TOKEN, 1);
  });

  it('keeps the stored token when the store cannot be read', async () => {
    const analytics = jest.fn().mockResolvedValue([]);
    const { service } = setup([row('int-1')], { facebook: { analytics } });
    (service as any).store = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async (): Promise<unknown> => undefined,
    };
    const { summary } = await service.runDailyHealth(NOW);
    expect(analytics).toHaveBeenCalledWith('page-int-1', TOKEN, 1);
    expect(summary.platformCalls).toBe(1);
  });
});

describe('DailyHealth that saves after the events (V101)', () => {
  const stored = (saved: Record<string, string>) =>
    JSON.parse(saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] ?? '{}');
  const revoked = () => ({
    facebook: {
      analytics: jest
        .fn()
        .mockRejectedValue(
          new Error('Error validating access token: Session has expired')
        ),
    },
  });
  const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);
  const disconnected = {
    kind: 'channel.disconnected' as const,
    updatedAt: 1,
    since: '1',
  };

  it('reports the event again on a retry after a failed attempt', async () => {
    const { service, posts, saved } = setup([row('int-1')], revoked());
    posts.findFailedPosts.mockRejectedValueOnce(new Error('database down'));

    await expect(service.prepareDailyHealth(NOW)).rejects.toThrow(
      'database down'
    );
    const retry = await service.prepareDailyHealth(NOW);

    expect(kinds(retry.events)).toEqual([
      'channel.auth_invalid',
      'health.daily',
    ]);
    expect(Object.keys(saved)).toEqual([]);
  });

  it('is why V101 exists: runDailyHealth has saved before it fails, the retry is silent', async () => {
    const { service, posts, saved } = setup([row('int-1')], revoked());
    posts.findFailedPosts.mockRejectedValueOnce(new Error('database down'));

    await expect(service.runDailyHealth(NOW)).rejects.toThrow('database down');
    expect(stored(saved)).toHaveProperty('int-1');
    const retry = await service.runDailyHealth(NOW);

    expect(kinds(retry.events)).toEqual(['health.daily']);
  });

  it('never writes to the store in prepareDailyHealth', async () => {
    const { service, saved } = setup(
      [row('int-1'), row('int-2', { disabled: true })],
      revoked()
    );
    const set = jest.fn();
    (service as any).store.set = set;

    const { changes } = await service.prepareDailyHealth(NOW);

    expect(Object.keys(changes).sort()).toEqual(['int-1', 'int-2']);
    expect(set).not.toHaveBeenCalled();
    expect(saved).toEqual({});
  });

  it('is silent in the next run once the changes are saved', async () => {
    const { service, saved } = setup([row('int-1')], revoked());
    const first = await service.prepareDailyHealth(NOW);
    await service.saveProblemChanges(first.changes);
    expect(stored(saved)).toHaveProperty('int-1');

    const next = await service.prepareDailyHealth(
      new Date(NOW.getTime() + DAY)
    );
    expect(kinds(next.events)).toEqual(['health.daily']);
    expect(next.changes).toEqual({});
  });

  it('keeps what another run wrote for another channel in between', async () => {
    const { service, saved } = setup([row('int-1')], revoked());
    const { changes } = await service.prepareDailyHealth(NOW);
    const other = {
      kind: 'channel.disconnected',
      updatedAt: NOW.getTime(),
      since: String(NOW.getTime()),
    };
    saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify({ 'int-9': other });

    await service.saveProblemChanges(changes);

    expect(Object.keys(stored(saved)).sort()).toEqual(['int-1', 'int-9']);
    expect(stored(saved)['int-9']).toEqual(other);
  });

  it('removes a solved channel when saving', async () => {
    const { service, integrations, saved } = setup(
      [row('int-1', { disabled: true })],
      {}
    );
    await service.checkChannels(NOW);
    expect(stored(saved)).toHaveProperty('int-1');

    integrations.getChannels.mockResolvedValue([
      row('int-1', { updatedAt: new Date(NOW.getTime() + 1000) }),
    ]);
    const { events, changes } = await service.prepareDailyHealth(
      new Date(NOW.getTime() + DAY)
    );
    expect(kinds(events)).toContain('channel.reconnected');
    expect(changes).toMatchObject({ 'int-1': { after: null } });
    expect(stored(saved)).toHaveProperty('int-1');

    await service.saveProblemChanges(changes);
    expect(stored(saved)).toEqual({});
  });

  it('throws without a write when Redis does not answer', async () => {
    const { service } = setup([], {});
    const set = jest.fn();
    (service as any).store = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set,
    };

    await expect(
      service.saveProblemChanges({
        'int-1': { before: null, after: disconnected },
      })
    ).rejects.toThrow('redis down');
    expect(set).not.toHaveBeenCalled();
  });

  it('treats an unreadable stored value as empty when saving', async () => {
    const { service, saved } = setup([], {});
    saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = '{not json';
    await service.saveProblemChanges({
      'int-1': { before: null, after: disconnected },
    });
    expect(Object.keys(stored(saved))).toEqual(['int-1']);
  });

  it('gives the same events and summary as runDailyHealth', async () => {
    const make = () =>
      setup(
        [
          row('int-revoked'),
          row('int-off', { disabled: true }),
          row('int-expiring', {
            tokenExpiration: new Date(NOW.getTime() + 2 * DAY),
          }),
        ],
        revoked(),
        [
          {
            id: 'post-err',
            organizationId: 'org-1',
            integrationId: 'int-off',
            publishDate: new Date('2026-10-25T09:00:00.000Z'),
            updatedAt: new Date('2026-10-25T09:00:30.000Z'),
            error: 'failed',
            integration: { providerIdentifier: 'facebook', customerId: null },
          },
        ]
      );
    const old = await make().service.runDailyHealth(NOW);
    const prepared = await make().service.prepareDailyHealth(NOW);

    expect(prepared.events).toEqual(old.events);
    expect(prepared.summary).toEqual(old.summary);
  });

  it('neither reads nor writes when there are no changes', async () => {
    const { service } = setup([], {});
    const get = jest.fn();
    const set = jest.fn();
    (service as any).store = { get, set };

    await service.saveProblemChanges({});

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('does not overwrite the real state when it was unreadable while preparing', async () => {
    const { service, saved } = setup([row('int-1')], revoked());
    const real = { ...disconnected, updatedAt: 5 };
    const store = (service as any).store;
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockImplementation(store.get);
    (service as any).store = { ...store, get };
    saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify({ 'int-1': real });

    const { changes } = await service.prepareDailyHealth(NOW);
    expect(changes['int-1'].before).toBeNull();

    await service.saveProblemChanges(changes);

    expect(stored(saved)['int-1']).toEqual(real);
  });
});

describe('"Zugang ungültig" ends only with a new token or a passed call', () => {
  const AUTH_ERROR = new Error(
    'Error validating access token: Session has expired'
  );
  const UPDATED = NOW.getTime() - DAY;
  const EXPIRES = NOW.getTime() + 30 * DAY;
  const renamedAt = new Date(NOW.getTime() + 1000);
  const NEW_EXPIRES = new Date(NOW.getTime() + 60 * DAY);
  const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

  // What an earlier DailyHealth left in Redis for int-x.
  const open = (patch: Record<string, unknown> = {}) => ({
    'int-x': {
      kind: 'channel.auth_invalid',
      updatedAt: UPDATED,
      since: '2026-10-26T06:00:00.000Z',
      tokenExpiration: EXPIRES,
      ...patch,
    },
  });

  describe('hourly check', () => {
    const hourly = async (after: ChannelRow) => {
      const ctx = setup([row('int-x')], {});
      ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify(open());
      ctx.integrations.getChannels.mockResolvedValue([after]);
      const result = await ctx.service.checkChannels(
        new Date(NOW.getTime() + 3600_000)
      );
      return {
        ...result,
        state: JSON.parse(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]),
      };
    };

    it('keeps a renamed channel open and the stored state as it was', async () => {
      const { events, state } = await hourly(
        row('int-x', { name: 'Y Social Umbenannt', updatedAt: renamedAt })
      );
      expect(events).toEqual([]);
      expect(state).toEqual(open());
    });

    it('reports "wieder verbunden" for a new tokenExpiration', async () => {
      const { events, state } = await hourly(
        row('int-x', { updatedAt: renamedAt, tokenExpiration: NEW_EXPIRES })
      );
      expect(kinds(events)).toEqual(['channel.reconnected']);
      expect(events[0].id).toBe(
        `channel.reconnected:int-x:${renamedAt.getTime()}-${Date.parse(
          '2026-10-26T06:00:00.000Z'
        )}`
      );
      expect(state).toEqual({});
    });
  });

  describe('DailyHealth with a change during the platform calls', () => {
    const run = async (
      method: 'runDailyHealth' | 'prepareDailyHealth',
      after: ChannelRow,
      analytics: jest.Mock
    ) => {
      const before = [row('int-x')];
      const ctx = setup(before, { facebook: { analytics } });
      ctx.integrations.getChannels
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce([after]);
      ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY] = JSON.stringify(open());
      const result = await ctx.service[method](NOW);
      return { ...ctx, ...result };
    };

    for (const method of ['runDailyHealth', 'prepareDailyHealth'] as const) {
      it(`${method}: a rename alone does not close it, the ok result expires`, async () => {
        const analytics = jest.fn().mockResolvedValue([]);
        const result = await run(
          method,
          row('int-x', { updatedAt: renamedAt }),
          analytics
        );
        expect(analytics).toHaveBeenCalledTimes(1);
        expect(kinds(result.events)).toEqual(['health.daily']);
        expect(result.summary.authInvalid).toEqual(['int-x']);
        if ('changes' in result) {
          expect(result.changes).toEqual({});
        } else {
          expect(
            JSON.parse(result.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY])
          ).toEqual(open());
        }
      });

      it(`${method}: a new tokenExpiration in the second read closes it`, async () => {
        const analytics = jest.fn().mockResolvedValue([]);
        const result = await run(
          method,
          row('int-x', { updatedAt: renamedAt, tokenExpiration: NEW_EXPIRES }),
          analytics
        );
        expect(kinds(result.events)).toEqual([
          'channel.reconnected',
          'health.daily',
        ]);
        expect(result.events[0].data).toEqual({
          previous: 'channel.auth_invalid',
        });
        expect(result.summary.authInvalid).toEqual([]);
        if ('changes' in result) {
          expect((result.changes as any)['int-x'].after).toBeNull();
        } else {
          expect(
            JSON.parse(result.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY])
          ).toEqual({});
        }
      });
    }
  });

  describe('a newly reported problem', () => {
    const analytics = () => jest.fn().mockRejectedValue(AUTH_ERROR);

    it('runDailyHealth stores tokenExpiration of the channel, not the token', async () => {
      const ctx = setup([row('int-x')], {
        facebook: { analytics: analytics() },
      });
      const { events } = await ctx.service.runDailyHealth(NOW);
      expect(kinds(events)).toContain('channel.auth_invalid');

      const stored = JSON.parse(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]);
      expect(stored['int-x']).toMatchObject({
        kind: 'channel.auth_invalid',
        updatedAt: UPDATED,
        tokenExpiration: EXPIRES,
      });
      expect(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]).not.toContain(TOKEN);
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    });

    it('stores null for a channel without tokenExpiration', async () => {
      const ctx = setup([row('int-x', { tokenExpiration: null })], {
        facebook: { analytics: analytics() },
      });
      await ctx.service.runDailyHealth(NOW);
      const stored = JSON.parse(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]);
      expect(stored['int-x']).toHaveProperty('tokenExpiration', null);
    });

    it('prepareDailyHealth puts tokenExpiration into changes, not the token', async () => {
      const ctx = setup([row('int-x')], {
        facebook: { analytics: analytics() },
      });
      const { events, changes } = await ctx.service.prepareDailyHealth(NOW);

      expect(changes['int-x'].before).toBeNull();
      expect(changes['int-x'].after).toMatchObject({
        kind: 'channel.auth_invalid',
        tokenExpiration: EXPIRES,
      });
      expect(JSON.stringify(changes)).not.toContain(TOKEN);
      expect(JSON.stringify(events)).not.toContain(TOKEN);
      expect(ctx.saved[YSOCIAL_CHANNEL_PROBLEMS_KEY]).toBeUndefined();
    });
  });
});
