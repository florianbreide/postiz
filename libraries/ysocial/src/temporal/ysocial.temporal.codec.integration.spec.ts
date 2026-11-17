import { randomBytes } from 'crypto';
import { Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import {
  Activity,
  ActivityMethod,
  TemporalModule,
  TemporalService,
} from 'nestjs-temporal-core';
import {
  isYsocialEncryptedPayload,
  YsocialPayloadCodec,
} from './payload.codec';
import {
  withYsocialPayloadCodec,
  YSOCIAL_PAYLOAD_CODEC_MARKER,
  ysocialDataConverter,
} from './ysocial.temporal.codec';
import { ysocialTokenKeyId } from '../tokens/token.crypto';

/**
 * Payload codec against a real Temporal server (PLAN PR 40). Skipped unless
 * YSOCIAL_IT_TEMPORAL_ADDRESS is set, for example 127.0.0.1:7233. Uses its
 * own namespace ysocial-codec-it (created if missing), never default, and
 * writes the codec marker only there. A local dev server is enough:
 *
 *   docker run --rm --name ysocial-codec-it -p 127.0.0.1:7233:7233 \
 *     --entrypoint temporal temporalio/auto-setup:1.28.1 \
 *     server start-dev --ip 0.0.0.0 --headless
 */
const address = process.env.YSOCIAL_IT_TEMPORAL_ADDRESS;
const namespace = 'ysocial-codec-it';
const describeIt = address ? describe : describe.skip;

const suffix = randomBytes(4).toString('hex');
const token = `it-secret-token-${suffix}`;
const failingUrl = `https://graph.example.invalid/v1/me?access_token=${token}`;
const newKey = () => randomBytes(32).toString('base64');
const kidOf = (key: string) => ysocialTokenKeyId(Buffer.from(key, 'base64'));
const codecFor = (key: string) =>
  new YsocialPayloadCodec({ key: Buffer.from(key, 'base64'), kid: kidOf(key) });

const workflowsPath = require.resolve('./test/codec.probe.workflow');
// The bundler reads the TypeScript sources here, swc must not pick up a
// .swcrc of Postiz (ysocial.worker.integration.spec.ts).
const bundlerOptions = {
  webpackConfigHook: (webpack: any) => {
    for (const rule of (webpack.module?.rules || []) as any[]) {
      if (rule?.use?.loader?.includes('swc-loader')) {
        rule.use.options = { ...rule.use.options, swcrc: false };
      }
    }
    return webpack;
  },
};

// Like BadBody in social.abstract.ts: message with the URL, request body in
// the details, plus a cause that names the URL as well.
const probeActivities = {
  ysocialCodecProbeChannel: async (id: string) => ({ id, token }),
  ysocialCodecProbeFail: async (url: string) => {
    throw new ApplicationFailure(
      `fetch failed: ${url}`,
      'bad_body',
      true,
      [{ identifier: 'facebook', json: '{}', body: `access_token=${token}` }],
      new Error(`connect timeout ${url}`)
    );
  },
};

@Injectable()
@Activity()
class CodecProbeActivity {
  @ActivityMethod()
  async ysocialCodecProbeChannel(id: string) {
    return probeActivities.ysocialCodecProbeChannel(id);
  }
}

const historyBytes = async (client: Client, workflowId: string) => {
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  return Buffer.from(temporal.api.history.v1.History.encode(history).finish());
};

const historyPayloads = async (client: Client, workflowId: string) => {
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  const payloads: temporal.api.common.v1.IPayload[] = [];
  for (const event of history.events || []) {
    const attributes = [
      event.workflowExecutionStartedEventAttributes?.input,
      event.activityTaskScheduledEventAttributes?.input,
      event.activityTaskCompletedEventAttributes?.result,
      event.workflowExecutionCompletedEventAttributes?.result,
      event.workflowExecutionSignaledEventAttributes?.input,
    ];
    for (const list of attributes) {
      payloads.push(...(list?.payloads || []));
    }
  }
  return payloads;
};

const waitFor = async (check: () => Promise<boolean>, what: string) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 30_000) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

describeIt('payload codec on a real Temporal server', () => {
  let connection: Connection;
  let native: NativeConnection;
  let plainClient: Client;

  const setMarker = (value: string) =>
    connection.workflowService.updateNamespace({
      namespace,
      updateInfo: { data: { [YSOCIAL_PAYLOAD_CODEC_MARKER]: value } },
    });
  const readMarker = async () =>
    (await connection.workflowService.describeNamespace({ namespace }))
      .namespaceInfo?.data?.[YSOCIAL_PAYLOAD_CODEC_MARKER];

  const rawWorker = (taskQueue: string, codec?: YsocialPayloadCodec) =>
    Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath,
      activities: probeActivities,
      bundlerOptions,
      ...(codec ? { dataConverter: ysocialDataConverter(codec) } : {}),
    });

  const nestApp = async (env: Record<string, string>) => {
    @Module({
      imports: [
        withYsocialPayloadCodec(
          TemporalModule.register({
            isGlobal: true,
            connection: { address: address!, namespace },
            taskQueue: `codec-nest-${suffix}`,
            logLevel: 'error',
            workers: [
              {
                taskQueue: `codec-nest-${suffix}`,
                workflowsPath,
                activityClasses: [CodecProbeActivity],
                autoStart: true,
                workerOptions: { bundlerOptions } as any,
              },
            ],
          }),
          env
        ),
      ],
      providers: [CodecProbeActivity],
    })
    class CodecTestModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [CodecTestModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    try {
      await connection.workflowService.registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: { seconds: 86_400 as any },
      });
    } catch {
      // exists already
    }
    await waitFor(async () => {
      try {
        await connection.workflowService.describeNamespace({ namespace });
        return true;
      } catch {
        return false;
      }
    }, 'namespace');
    await setMarker('');
    plainClient = new Client({ connection, namespace });
  }, 60_000);

  afterAll(async () => {
    await setMarker('').catch(() => undefined);
    await native?.close();
    await connection?.close();
    jest.restoreAllMocks();
  });

  it('a run started before the codec keeps running, new payloads are encrypted, a client without codec cannot read them', async () => {
    const codec = codecFor(newKey());
    const taskQueue = `codec-raw-${suffix}`;
    const workflowId = `codec-raw-${suffix}`;

    // 1. Before the deploy: worker and client without codec.
    const before = await rawWorker(taskQueue);
    await before.runUntil(async () => {
      await plainClient.workflow.start('ysocialCodecProbeWorkflow', {
        workflowId,
        taskQueue,
        args: [{ id: 'channel-1', wait: true }],
      });
      await waitFor(
        async () =>
          (
            await plainClient.workflow.getHandle(workflowId).fetchHistory()
          ).events!.some((e) => !!e.activityTaskCompletedEventAttributes),
        'first activity'
      );
    });
    expect((await historyBytes(plainClient, workflowId)).includes(token)).toBe(
      true
    );

    // 2. After the deploy: worker and client with codec, same run.
    const encryptedClient = new Client({
      connection,
      namespace,
      dataConverter: ysocialDataConverter(codec),
    });
    const after = await rawWorker(taskQueue, codec);
    const result = await after.runUntil(async () => {
      const handle = encryptedClient.workflow.getHandle(workflowId);
      await handle.signal('codecProbeContinue');
      return handle.result();
    });
    expect(result).toEqual({ first: token, second: token });

    const payloads = await historyPayloads(plainClient, workflowId);
    const encrypted = payloads.filter((p) =>
      isYsocialEncryptedPayload(p as any)
    );
    // Old: start input, first activity input and result. New: second
    // activity input and result, workflow result. The signal has no args.
    expect(payloads.length - encrypted.length).toBe(3);
    expect(encrypted.length).toBe(3);

    // 3. A client without codec (the backend without patch 6) cannot read
    // the result any more.
    await expect(
      plainClient.workflow.getHandle(workflowId).result()
    ).rejects.toThrow();
  }, 120_000);

  it('failures: message and details encrypted, the workflow sees the same error JSON as without codec (Post.error), the client reads the message', async () => {
    const codec = codecFor(newKey());
    const encryptedClient = new Client({
      connection,
      namespace,
      dataConverter: ysocialDataConverter(codec),
    });

    const plainQueue = `codec-fail-plain-${suffix}`;
    const plainJson = await (
      await rawWorker(plainQueue)
    ).runUntil(
      plainClient.workflow.execute('ysocialCodecProbeFailureWorkflow', {
        workflowId: `codec-fail-plain-${suffix}`,
        taskQueue: plainQueue,
        args: [{ url: failingUrl, rethrow: false }],
      })
    );

    const encryptedQueue = `codec-fail-enc-${suffix}`;
    const worker = await rawWorker(encryptedQueue, codec);
    const [encryptedJson, failed] = await worker.runUntil(async () => {
      const json = await encryptedClient.workflow.execute(
        'ysocialCodecProbeFailureWorkflow',
        {
          workflowId: `codec-fail-enc-${suffix}`,
          taskQueue: encryptedQueue,
          args: [{ url: failingUrl, rethrow: false }],
        }
      );
      const error = await encryptedClient.workflow
        .execute('ysocialCodecProbeFailureWorkflow', {
          workflowId: `codec-fail-rethrow-${suffix}`,
          taskQueue: encryptedQueue,
          args: [{ url: failingUrl, rethrow: true }],
        })
        .catch((err) => err);
      return [json, error];
    });

    // What changeState would write to Post.error stays as it was, to the
    // order of the keys.
    expect(encryptedJson).toBe(plainJson);
    expect(encryptedJson).toContain(`fetch failed: ${failingUrl}`);

    // Nothing of the URL, the body or the stack in the history.
    for (const id of [
      `codec-fail-enc-${suffix}`,
      `codec-fail-rethrow-${suffix}`,
    ]) {
      expect((await historyBytes(plainClient, id)).includes(token)).toBe(false);
    }

    // The backend reads the message like media.service does (cause chain).
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    let cause: any = failed;
    while (cause?.cause && cause.cause !== cause) {
      cause = cause.cause;
    }
    expect(cause.message).toBe(`connect timeout ${failingUrl}`);
  }, 120_000);

  it('Nest: client and worker of nestjs-temporal-core encrypt, no token in the history, namespace marked', async () => {
    const key = newKey();
    const app = await nestApp({ YSOCIAL_TEMPORAL_KEY: key });
    try {
      const client = app.get(TemporalService).client.getRawClient()!;
      expect(client.options.loadedDataConverter.payloadCodecs).toHaveLength(1);

      const workflowId = `codec-nest-${suffix}`;
      const handle = await client.workflow.start('ysocialCodecProbeWorkflow', {
        workflowId,
        taskQueue: `codec-nest-${suffix}`,
        args: [{ id: 'channel-2', wait: false }],
      });
      expect(await handle.result()).toEqual({ first: token, second: token });

      expect(
        (await historyBytes(plainClient, workflowId)).includes(token)
      ).toBe(false);
      const payloads = await historyPayloads(plainClient, workflowId);
      expect(payloads.length).toBeGreaterThanOrEqual(6);
      expect(payloads.every((p) => isYsocialEncryptedPayload(p as any))).toBe(
        true
      );
      expect(await readMarker()).toBe(kidOf(key));
    } finally {
      await app.close();
    }

    // Marked namespace: without the key, or with another one, no start.
    await expect(nestApp({})).rejects.toThrow(/YSOCIAL_TEMPORAL_KEY fehlt/);
    await expect(nestApp({ YSOCIAL_TEMPORAL_KEY: newKey() })).rejects.toThrow(
      /YSOCIAL_TEMPORAL_KEY passt nicht/
    );

    // Marker switched off on purpose: Postiz starts without the key again.
    await setMarker('off');
    const plainApp = await nestApp({});
    try {
      expect(
        plainApp.get(TemporalService).client.getRawClient()!.options
          .loadedDataConverter.payloadCodecs
      ).toHaveLength(0);
    } finally {
      await plainApp.close();
    }
  }, 180_000);
});
