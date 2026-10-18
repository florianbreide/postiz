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
import { deliveryWorkflowId } from '../../../../libraries/ysocial/src/events/hub.event';
import {
  YsocialStatusStore,
  YsocialWorkerStatusRecord,
} from '../../../../libraries/ysocial/src/worker/worker.status';

/**
 * Runs the real ysocial worker against a real Temporal server (PR 16 QA 4).
 * Skipped unless YSOCIAL_IT_TEMPORAL_ADDRESS is set, e.g. 127.0.0.1:7233.
 * The namespace (YSOCIAL_IT_NAMESPACE, default ysocial) must exist.
 *
 * The mock hub answers the first delivery with 503, so the test also shows
 * that the retry carries the same event id.
 */
const address = process.env.YSOCIAL_IT_TEMPORAL_ADDRESS;
const namespace = process.env.YSOCIAL_IT_NAMESPACE || 'ysocial';
const describeIt = address ? describe : describe.skip;

// Production bundles the compiled JavaScript from dist. Here the bundler
// reads the TypeScript sources, and swc would pick up the .swcrc of Postiz
// in apps/orchestrator, whose baseUrl points to another machine.
class SourceWorkerService extends YsocialWorkerService {
  protected createWorker(
    connection: NativeConnection,
    config: YsocialWorkerConfig
  ) {
    const activities = new YsocialActivities();
    return Worker.create({
      ...ysocialWorkerOptions(connection, config, activities),
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
    key: string | string[] | undefined;
    auth?: string;
  }[] = [];
  const statuses = [503];
  const writes: YsocialWorkerStatusRecord[] = [];
  let hub: Server;
  let service: YsocialWorkerService;
  let connection: Connection;
  let client: Client;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    hub = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({
          id: JSON.parse(body).id,
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

    service = new SourceWorkerService(new YsocialActivities());
    const store: YsocialStatusStore = {
      get: async () => undefined,
      set: async (_key: string, value: string) =>
        writes.push(JSON.parse(value)),
    };
    (service as any).statusStore = store;
    service.onApplicationBootstrap();

    // Bundling the workflows takes a few seconds.
    const started = Date.now();
    while (writes[writes.length - 1]?.state !== 'running') {
      if (Date.now() - started > 60_000) {
        throw new Error(`worker did not start: ${JSON.stringify(writes)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    connection = await Connection.connect({ address });
    client = new Client({ connection, namespace });
  }, 90_000);

  afterAll(async () => {
    await service?.beforeApplicationShutdown();
    await connection?.close();
    await new Promise((resolve) => hub?.close(resolve));
    process.env = env;
    jest.restoreAllMocks();
  });

  it('runs a ping in the namespace and the hub gets its event, twice with the same id', async () => {
    const workflowId = `ysocial-ping-it-${randomBytes(4).toString('hex')}`;
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

    expect(received).toEqual([
      { id: ping.eventId, key: ping.eventId, auth: `Bearer ${hubToken}` },
      { id: ping.eventId, key: ping.eventId, auth: `Bearer ${hubToken}` },
    ]);

    // Same ping id again: the event was delivered, Temporal rejects a
    // second delivery workflow.
    const again = await client.workflow.execute('ysocialPingWorkflow', {
      workflowId,
      taskQueue: 'ysocial-postiz',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    expect(again.delivery).toBe('duplicate');
    expect(received).toHaveLength(2);

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
});
