// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { randomBytes } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import {
  ApplicationFailure,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';
import {
  buildYsocialActivities,
  verifyPostStartOptions,
  YsocialActivities,
  ysocialActivityNames,
} from './ysocial.activities';
import { createHubEvent } from '../../../../libraries/ysocial/src/events/hub.event';

const POSTIZ_ACTIVITIES = join(__dirname, '..', 'activities');

// Method names of the Postiz activity classes, read from their source files.
// Importing them would load every provider SDK.
const postizActivityNames = () =>
  readdirSync(POSTIZ_ACTIVITIES)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      Array.from(
        readFileSync(join(POSTIZ_ACTIVITIES, file), 'utf8').matchAll(
          /^\s{2}(?:async\s+)?([a-zA-Z_]\w*)\s*\(/gm
        ),
        (match) => match[1]
      )
    )
    .filter((name) => name !== 'constructor');

describe('ysocial activities', () => {
  it('all start with "ysocial" (PLAN R34)', () => {
    expect(ysocialActivityNames().length).toBeGreaterThan(0);
    for (const name of ysocialActivityNames()) {
      expect(name).toMatch(/^ysocial[A-Z]/);
    }
  });

  it('share no name with a Postiz activity', () => {
    const postiz = postizActivityNames();
    expect(postiz).toEqual(
      expect.arrayContaining(['getIntegrationsById', 'refreshToken'])
    );
    for (const name of ysocialActivityNames()) {
      expect(postiz).not.toContain(name);
    }
  });

  it('are registered bound to the instance', () => {
    const instance = new YsocialActivities({} as any, {} as any, {} as any);
    const activities = buildYsocialActivities(instance);
    expect(Object.keys(activities).sort()).toEqual(
      ysocialActivityNames().sort()
    );
  });
});

describe('ysocialDeliverEvent', () => {
  const env = { ...process.env };
  const hubToken = randomBytes(32).toString('hex');
  const event = createHubEvent({
    kind: 'ping',
    subject: { type: 'system', id: 'ysocial-worker' },
    stateKey: 'qa',
    occurredAt: '2026-10-19T07:00:00.000Z',
  });
  let server: Server;
  let statuses: number[];
  let received: string[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push(JSON.parse(body).id);
        res.statusCode = statuses.shift() ?? 202;
        res.setHeader('connection', 'close');
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
  });

  beforeEach(() => {
    statuses = [];
    received = [];
    const { port } = server.address() as AddressInfo;
    process.env.HUB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    process.env.HUB_INTERNAL_TOKEN = hubToken;
    process.env.YSOCIAL_TEMPORAL_NAMESPACE = 'ysocial';
  });

  afterAll(async () => {
    process.env = env;
    await new Promise((resolve) => server.close(resolve));
  });

  const deliver = () =>
    new YsocialActivities({} as any, {} as any, {} as any).ysocialDeliverEvent(
      event
    );

  it('delivers to the mock hub', async () => {
    expect(await deliver()).toEqual({ status: 202, duplicate: false });
    expect(received).toEqual([event.id]);
  });

  it('asks Temporal for another attempt with the same event while the hub is down', async () => {
    statuses = [503];
    const error = await deliver().catch((err) => err);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.type).toBe('YsocialHubUnavailable');
    expect(error.nonRetryable).toBe(false);
    await deliver();
    expect(received).toEqual([event.id, event.id]);
  });

  it('stops on a final answer of the hub', async () => {
    statuses = [400];
    const error = await deliver().catch((err) => err);
    expect(error.type).toBe('YsocialHubRejected');
    expect(error.nonRetryable).toBe(true);
  });

  it('sends nothing without configuration', async () => {
    delete process.env.HUB_INTERNAL_TOKEN;
    const error = await deliver().catch((err) => err);
    expect(error.type).toBe('YsocialNotConfigured');
    expect(received).toEqual([]);
  });
});

describe('ysocialStartPostVerifications', () => {
  const setup = (postIds: string[], existing: string[] = []) => {
    const start = jest.fn(async (_type: string, options: any) => {
      if (existing.includes(options.workflowId)) {
        throw new WorkflowExecutionAlreadyStartedError(
          'already started',
          options.workflowId,
          'ysocialVerifyPostWorkflow'
        );
      }
      return {};
    });
    const verification = {
      findPostIdsToVerify: jest.fn().mockResolvedValue(postIds),
    };
    const temporal = {
      get: jest.fn().mockResolvedValue({ workflow: { start } }),
    };
    const activities = new YsocialActivities(
      verification as any,
      temporal as any,
      {} as any
    );
    return { activities, start, verification, temporal };
  };

  it('starts ysocial-verify-<postId> per post and skips running ones', async () => {
    const { activities, start, verification } = setup(
      ['post-1', 'post-2', 'post-3'],
      ['ysocial-verify-post-2']
    );
    expect(await activities.ysocialStartPostVerifications({})).toEqual({
      due: 3,
      started: 2,
      alreadyStarted: 1,
    });
    expect(verification.findPostIdsToVerify).toHaveBeenCalledWith(
      expect.any(Date),
      undefined
    );
    expect(
      start.mock.calls.map(([type, options]) => [type, options.workflowId])
    ).toEqual([
      ['ysocialVerifyPostWorkflow', 'ysocial-verify-post-1'],
      ['ysocialVerifyPostWorkflow', 'ysocial-verify-post-2'],
      ['ysocialVerifyPostWorkflow', 'ysocial-verify-post-3'],
    ]);
  });

  it('passes the window of a run by hand', async () => {
    const { activities, verification } = setup([]);
    await activities.ysocialStartPostVerifications({ windowMinutes: 2880 });
    expect(verification.findPostIdsToVerify).toHaveBeenCalledWith(
      expect.any(Date),
      2880
    );
  });

  it('needs no Temporal connection without due posts', async () => {
    const { activities, temporal } = setup([]);
    expect(await activities.ysocialStartPostVerifications()).toEqual({
      due: 0,
      started: 0,
      alreadyStarted: 0,
    });
    expect(temporal.get).not.toHaveBeenCalled();
  });

  it('starts each post once, on ysocial-postiz, without search attributes', () => {
    expect(verifyPostStartOptions('post-1')).toEqual({
      workflowId: 'ysocial-verify-post-1',
      taskQueue: 'ysocial-postiz',
      args: [{ postId: 'post-1' }],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
  });

  it('passes other start errors on', async () => {
    const { activities, start } = setup(['post-1']);
    start.mockRejectedValueOnce(new Error('unavailable'));
    await expect(activities.ysocialStartPostVerifications()).rejects.toThrow(
      'unavailable'
    );
  });
});

describe('channel checks', () => {
  it('hand the hourly check and DailyHealth to the service', async () => {
    const channelHealth = {
      checkChannels: jest.fn().mockResolvedValue({ channels: 2, events: [] }),
      runDailyHealth: jest
        .fn()
        .mockResolvedValue({ events: [], summary: { day: '2026-10-27' } }),
    };
    const activities = new YsocialActivities(
      {} as any,
      {} as any,
      channelHealth as any
    );
    expect(await activities.ysocialCheckChannels({})).toEqual({
      channels: 2,
      events: [],
    });
    expect(await activities.ysocialRunDailyHealth({})).toEqual({
      events: [],
      summary: { day: '2026-10-27' },
    });
  });
});
