// The real IntegrationManager loads every provider, some of them ESM-only.
// The verification service is faked below anyway.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { randomBytes } from 'crypto';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Logger } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  ysocialWorkerOptions,
  YsocialWorkerService,
} from './ysocial.worker.service';
import { YsocialWorkerConfig } from '../../../../libraries/ysocial/src/worker/worker.config';
import { YsocialActivities } from './ysocial.activities';
import { YsocialTemporalClient } from './ysocial.temporal.client';
import { deliveryWorkflowId } from '../../../../libraries/ysocial/src/events/hub.event';
import {
  YsocialStatusStore,
  YsocialWorkerStatusRecord,
} from '../../../../libraries/ysocial/src/worker/worker.status';
import {
  PlatformCheck,
  PostVerificationSnapshot,
} from '../../../../libraries/ysocial/src/verification/post.verification';

/**
 * Runs the real ysocial worker against a real Temporal server (PR 16 QA 4,
 * PR 17). Skipped unless YSOCIAL_IT_TEMPORAL_ADDRESS is set, for example
 * 127.0.0.1:7233. The namespace (YSOCIAL_IT_NAMESPACE, default ysocial) must
 * exist. No database: the post data comes from a fake service.
 *
 * The worker creates its schedules there. The test deletes them at the end,
 * a local orchestrator with the worker creates them again on start.
 */
const address = process.env.YSOCIAL_IT_TEMPORAL_ADDRESS;
const namespace = process.env.YSOCIAL_IT_NAMESPACE || 'ysocial';
const describeIt = address ? describe : describe.skip;

const MIN = 60_000;
const suffix = randomBytes(4).toString('hex');
const queuedPost = `it-queue-${suffix}`;
const publishedPost = `it-published-${suffix}`;

// Two invented posts, both scheduled 10 minutes ago.
const snapshot = (
  id: string,
  state: 'QUEUE' | 'PUBLISHED'
): PostVerificationSnapshot => ({
  id,
  organizationId: 'org-it',
  integrationId: 'int-it',
  state,
  publishDate: new Date(Date.now() - 10 * MIN).toISOString(),
  deleted: false,
  releaseURL: state === 'PUBLISHED' ? 'https://www.facebook.com/1_2' : null,
  error: null,
  integration: {
    providerIdentifier: 'facebook',
    customerId: null,
    disconnected: false,
  },
});

const snapshots = new Map<string, PostVerificationSnapshot>();
const fakeVerification = {
  findPostIdsToVerify: async () => [queuedPost, publishedPost],
  loadSnapshot: async (postId: string) => snapshots.get(postId) || null,
  checkOnPlatform: async (): Promise<PlatformCheck> => ({ result: 'found' }),
};

// Production bundles the compiled JavaScript from dist. Here the bundler
// reads the TypeScript sources, and swc would pick up the .swcrc of Postiz
// in apps/orchestrator, whose baseUrl points to another machine.
class SourceWorkerService extends YsocialWorkerService {
  constructor(
    private _testActivities: YsocialActivities,
    temporal: YsocialTemporalClient
  ) {
    super(_testActivities, temporal);
  }

  protected createWorker(
    connection: NativeConnection,
    config: YsocialWorkerConfig
  ) {
    return Worker.create({
      ...ysocialWorkerOptions(connection, config, this._testActivities),
      bundlerOptions: {
        webpackConfigHook: (webpack) => {
          for (const rule of (webpack.module?.rules || []) as any[]) {
            if (rule?.use?.loader?.includes('swc-loader')) {
              rule.use.options = { ...rule.use.options, swcrc: false };
            }
          }
          return webpack;
        },
      },
    });
  }
}

describeIt('ysocial worker on a real Temporal server', () => {
  const env = { ...process.env };
  const hubToken = randomBytes(32).toString('hex');
  const received: {
    id: string;
    kind: string;
    key: string | string[] | undefined;
    auth?: string;
  }[] = [];
  const statuses = [503];
  const writes: YsocialWorkerStatusRecord[] = [];
  let hub: Server;
  let temporal: YsocialTemporalClient;
  let service: YsocialWorkerService;
  let connection: Connection;
  let client: Client;

  const waitFor = async (check: () => boolean, what: string, ms = 60_000) => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > ms) {
        throw new Error(`timeout waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    hub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const event = JSON.parse(body);
        received.push({
          id: event.id,
          kind: event.kind,
          key: req.headers['idempotency-key'],
          auth: req.headers.authorization,
        });
        res.statusCode = statuses.shift() ?? 202;
        res.setHeader('connection', 'close');
        res.end();
      });
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));

    process.env.TEMPORAL_ADDRESS = address;
    process.env.HUB_INTERNAL_URL = `http://127.0.0.1:${
      (hub.address() as AddressInfo).port
    }`;
    process.env.HUB_INTERNAL_TOKEN = hubToken;
    process.env.YSOCIAL_TEMPORAL_NAMESPACE = namespace;
    delete process.env.YSOCIAL_WORKER_ENABLED;

    snapshots.set(queuedPost, snapshot(queuedPost, 'QUEUE'));
    snapshots.set(publishedPost, snapshot(publishedPost, 'PUBLISHED'));

    temporal = new YsocialTemporalClient();
    const activities = new YsocialActivities(
      fakeVerification as any,
      temporal,
      {} as any
    );
    service = new SourceWorkerService(activities, temporal);
    const store: YsocialStatusStore = {
      get: async () => undefined,
      set: async (_key: string, value: string) =>
        writes.push(JSON.parse(value)),
    };
    (service as any).statusStore = store;
    service.onApplicationBootstrap();

    // Bundling the workflows takes a few seconds.
    await waitFor(
      () => writes[writes.length - 1]?.state === 'running',
      `worker start: ${JSON.stringify(writes)}`
    );

    connection = await Connection.connect({ address });
    client = new Client({ connection, namespace });
  }, 90_000);

  afterAll(async () => {
    for (const id of [`ysocial-verify-${queuedPost}`]) {
      await client?.workflow
        .getHandle(id)
        .terminate('end of test')
        .catch((): undefined => undefined);
    }
    for (const id of [
      'ysocial-post-verification',
      'ysocial-channel-check',
      'ysocial-daily-health',
    ]) {
      await client?.schedule
        .getHandle(id)
        .delete()
        .catch((): undefined => undefined);
    }
    await service?.beforeApplicationShutdown();
    await temporal?.beforeApplicationShutdown();
    await connection?.close();
    await new Promise((resolve) => hub?.close(resolve));
    process.env = env;
    jest.restoreAllMocks();
  });

  it('runs a ping in the namespace and the hub gets its event, twice with the same id', async () => {
    const workflowId = `ysocial-ping-it-${suffix}`;
    const ping = await client.workflow.execute('ysocialPingWorkflow', {
      workflowId,
      taskQueue: 'ysocial-postiz',
    });
    expect(ping).toEqual({
      eventId: `ping:ysocial-worker:${workflowId}`,
      delivery: 'started',
    });

    const delivery = await client.workflow
      .getHandle(deliveryWorkflowId(ping.eventId))
      .result();
    expect(delivery).toEqual({
      eventId: ping.eventId,
      status: 202,
      duplicate: false,
    });

    const pings = received.filter((r) => r.kind === 'ping');
    expect(pings).toEqual([
      {
        id: ping.eventId,
        kind: 'ping',
        key: ping.eventId,
        auth: `Bearer ${hubToken}`,
      },
      {
        id: ping.eventId,
        kind: 'ping',
        key: ping.eventId,
        auth: `Bearer ${hubToken}`,
      },
    ]);

    // Same ping id again: the event was delivered, Temporal rejects a
    // second delivery workflow.
    const again = await client.workflow.execute('ysocialPingWorkflow', {
      workflowId,
      taskQueue: 'ysocial-postiz',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    expect(again.delivery).toBe('duplicate');
    expect(received.filter((r) => r.kind === 'ping')).toHaveLength(2);

    for (const id of [workflowId, deliveryWorkflowId(ping.eventId)]) {
      const description = await client.workflow.getHandle(id).describe();
      expect(description.taskQueue).toBe('ysocial-postiz');
      // Temporal itself adds BuildIds. Postiz's attributes must be absent.
      const names = [
        ...Object.keys(description.searchAttributes || {}),
        ...description.typedSearchAttributes.getAll().map((a) => a.key.name),
      ];
      expect(names).not.toContain('postId');
      expect(names).not.toContain('organizationId');
    }
  }, 120_000);

  it('creates the PostVerification schedule, every minute', async () => {
    await waitFor(
      () => writes.some((w) => w.schedules === 'ready'),
      'schedules'
    );
    const schedule = await client.schedule
      .getHandle('ysocial-post-verification')
      .describe();
    expect(schedule.action).toMatchObject({
      workflowType: 'ysocialPostVerificationWorkflow',
      taskQueue: 'ysocial-postiz',
    });
    expect(schedule.spec.intervals?.[0].every).toBe(60_000);
    expect(schedule.policies.overlap).toBe('SKIP');
  });

  it('plans the next DailyHealth for 07:00 in Berlin (PR 18 QA 2)', async () => {
    const schedule = await client.schedule
      .getHandle('ysocial-daily-health')
      .describe();
    expect(schedule.spec.timezone).toBe('Europe/Berlin');
    const next = schedule.info.nextActionTimes[0];
    const berlin = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    }).format(next);
    expect(berlin).toBe('07:00');

    const hourly = await client.schedule
      .getHandle('ysocial-channel-check')
      .describe();
    expect(hourly.info.nextActionTimes[0].getUTCMinutes()).toBe(15);
  });

  it('starts one verification per post and reports both posts to the hub', async () => {
    const first = await client.workflow.execute(
      'ysocialPostVerificationWorkflow',
      {
        workflowId: `ysocial-post-verification-it-${suffix}`,
        taskQueue: 'ysocial-postiz',
      }
    );
    // The schedule may have started them a moment earlier.
    expect(first.due).toBe(2);
    expect(first.started + first.alreadyStarted).toBe(2);

    const second = await client.workflow.execute(
      'ysocialPostVerificationWorkflow',
      {
        workflowId: `ysocial-post-verification-it2-${suffix}`,
        taskQueue: 'ysocial-postiz',
      }
    );
    expect(second).toEqual({ due: 2, started: 0, alreadyStarted: 2 });

    const verified = await client.workflow
      .getHandle(`ysocial-verify-${publishedPost}`)
      .result();
    expect(verified).toEqual({
      postId: publishedPost,
      outcome: 'verified',
      platformChecks: 1,
    });

    await waitFor(
      () =>
        received.some((r) => r.kind === 'post.verified') &&
        received.some((r) => r.kind === 'post.not_published'),
      'post events at the mock hub'
    );
    expect(received.find((r) => r.kind === 'post.not_published')!.id).toMatch(
      new RegExp(`^post\\.not_published:${queuedPost}:\\d+$`)
    );
    expect(received.find((r) => r.kind === 'post.verified')!.id).toMatch(
      new RegExp(`^post\\.verified:${publishedPost}:\\d+$`)
    );
    expect(received.filter((r) => r.kind.startsWith('post.'))).toHaveLength(2);

    const description = await client.workflow
      .getHandle(`ysocial-verify-${queuedPost}`)
      .describe();
    expect(description.status.name).toBe('RUNNING');
    expect(
      description.typedSearchAttributes.getAll().map((a) => a.key.name)
    ).not.toContain('postId');
  }, 120_000);
});
