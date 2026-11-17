// The real IntegrationManager loads every provider, some of them ESM-only.
// Only the list of providers is needed here.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
  socialIntegrationList: [
    { identifier: 'x', maxConcurrentJob: 1 },
    { identifier: 'linkedin' },
    { identifier: 'instagram-standalone' },
  ],
}));

// Replaces Worker.create only, to see which options nestjs-temporal-core
// passes on. The rest of the package (NativeConnection etc.) stays real.
jest.mock('@temporalio/worker', () => ({
  ...jest.requireActual('@temporalio/worker'),
  Worker: { create: jest.fn() },
}));

import { randomBytes } from 'crypto';
import { DynamicModule, Logger } from '@nestjs/common';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import {
  TEMPORAL_CLIENT,
  TEMPORAL_MODULE_OPTIONS,
  TemporalModule,
  TemporalWorkerManagerService,
} from 'nestjs-temporal-core';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { emailQueues } from '@gitroom/nestjs-libraries/temporal/email.queues';
import {
  readYsocialTemporalKey,
  YSOCIAL_TEMPORAL_KEY_ENV,
  YsocialPayloadCodec,
  YsocialTemporalKeyError,
} from './payload.codec';
import {
  withYsocialPayloadCodec,
  YSOCIAL_PAYLOAD_CODEC_MARKER,
  YsocialPayloadCodecCheck,
} from './ysocial.temporal.codec';

const newKeyBase64 = () => randomBytes(32).toString('base64');
const keyOf = (base64: string) =>
  readYsocialTemporalKey({ [YSOCIAL_TEMPORAL_KEY_ENV]: base64 })!;

const providerOf = (module: DynamicModule, token: string): any =>
  (module.providers as any[]).find((p) => p.provide === token);

const optionsOf = (module: DynamicModule): any =>
  providerOf(module, TEMPORAL_MODULE_OPTIONS).useValue;

const realModule = (extra: Record<string, unknown> = {}) =>
  TemporalModule.register({
    connection: { address: 'localhost:7233', namespace: 'ns' },
    taskQueue: 'main',
    ...extra,
  } as any);

const workerOf = (
  taskQueue: string,
  workerOptions?: Record<string, unknown>
) => ({
  taskQueue,
  activityClasses: [] as unknown[],
  autoStart: false,
  ...(workerOptions ? { workerOptions } : {}),
});

const spyLogger = () => {
  const lines: string[] = [];
  for (const method of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, method).mockImplementation(((message: any) => {
      lines.push(String(message));
    }) as any);
  }
  return lines;
};

afterEach(() => jest.restoreAllMocks());

describe('withYsocialPayloadCodec', () => {
  it('finds the providers of the real nestjs-temporal-core (upstream guard)', () => {
    const wrapped = withYsocialPayloadCodec(realModule(), {});
    expect(providerOf(wrapped, TEMPORAL_MODULE_OPTIONS).useValue).toBeDefined();
    expect(typeof providerOf(wrapped, TEMPORAL_CLIENT).useFactory).toBe(
      'function'
    );
  });

  it('sets one YsocialPayloadCodec on every worker and keeps workerOptions', () => {
    const base64 = newKeyBase64();
    const module = realModule({
      workers: [
        workerOf('a', { maxHeartbeatThrottleInterval: '15s' }),
        workerOf('b'),
      ],
      worker: workerOf('c', { maxConcurrentActivityTaskExecutions: 3 }),
    });
    const wrapped = withYsocialPayloadCodec(module, {
      [YSOCIAL_TEMPORAL_KEY_ENV]: base64,
    });
    const options = optionsOf(wrapped);
    const all = [...options.workers, options.worker];
    expect(all).toHaveLength(3);
    for (const worker of all) {
      const converter = worker.workerOptions.dataConverter;
      expect(converter.payloadCodecs).toHaveLength(1);
      expect(converter.payloadCodecs[0]).toBeInstanceOf(YsocialPayloadCodec);
      expect(converter.failureConverterPath).toMatch(/failure\.converter/);
    }
    expect(options.workers[0].workerOptions.maxHeartbeatThrottleInterval).toBe(
      '15s'
    );
    expect(
      options.worker.workerOptions.maxConcurrentActivityTaskExecutions
    ).toBe(3);
  });

  it('leaves the options alone without key, but replaces the client', () => {
    const module = realModule({ workers: [workerOf('a')] });
    const client = providerOf(module, TEMPORAL_CLIENT);
    const wrapped = withYsocialPayloadCodec(module, {});
    expect(optionsOf(wrapped).workers[0].workerOptions).toBeUndefined();
    expect(providerOf(wrapped, TEMPORAL_CLIENT)).not.toBe(client);
  });

  it('throws "ysocial patch 6 prüfen" when the providers are missing', () => {
    expect(() =>
      withYsocialPayloadCodec({ module: class Empty {}, providers: [] }, {})
    ).toThrow(/ysocial patch 6 prüfen/);
    expect(() =>
      withYsocialPayloadCodec(
        {
          module: class Other {},
          providers: [
            { provide: TEMPORAL_MODULE_OPTIONS, useFactory: () => ({}) },
            { provide: TEMPORAL_CLIENT, useValue: {} },
          ],
        },
        {}
      )
    ).toThrow(/ysocial patch 6 prüfen/);
  });

  it('throws and logs for an invalid key, without the value', () => {
    const lines = spyLogger();
    expect(() =>
      withYsocialPayloadCodec(realModule(), {
        [YSOCIAL_TEMPORAL_KEY_ENV]: 'secret-but-invalid',
      })
    ).toThrow(YsocialTemporalKeyError);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^temporal codec check failed: /);
    expect(lines[0]).not.toContain('secret-but-invalid');
  });
});

describe('patch 6 in getTemporalModule', () => {
  const saved = process.env[YSOCIAL_TEMPORAL_KEY_ENV];
  beforeEach(() => {
    process.env[YSOCIAL_TEMPORAL_KEY_ENV] = newKeyBase64();
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[YSOCIAL_TEMPORAL_KEY_ENV];
    } else {
      process.env[YSOCIAL_TEMPORAL_KEY_ENV] = saved;
    }
  });

  it('gives every worker the data converter', () => {
    const module = getTemporalModule(true, '/x', []);
    const workers: any[] = optionsOf(module).workers;
    const queues = workers.map((w) => w.taskQueue);
    // x and linkedin; instagram-standalone has a dash and no own worker.
    expect(queues).toEqual(
      expect.arrayContaining([
        'main',
        'x',
        'linkedin',
        ...Object.values(emailQueues).map((q) => q.taskQueue),
      ])
    );
    expect(queues).not.toContain('instagram');
    expect(workers.length).toBe(3 + Object.keys(emailQueues).length);
    for (const worker of workers) {
      expect(
        worker.workerOptions.dataConverter.payloadCodecs[0]
      ).toBeInstanceOf(YsocialPayloadCodec);
    }
    // The own options of Postiz stay.
    expect(
      workers.find((w) => w.taskQueue === 'x').workerOptions
        .maxConcurrentActivityTaskExecutions
    ).toBe(1);
  });

  it('has no workers for the backend, the client is replaced anyway', () => {
    const original = providerOf(realModule(), TEMPORAL_CLIENT);
    const module = getTemporalModule(false);
    expect(optionsOf(module).workers).toBeUndefined();
    const client = providerOf(module, TEMPORAL_CLIENT);
    expect(client).toBeDefined();
    expect(client.useFactory).not.toBe(original.useFactory);
  });
});

// Guard for updates of nestjs-temporal-core. The package must pass
// workerOptions.dataConverter on to Worker.create, and the codec depends on
// it. The test runs the package service the way the package does (its
// internals: TemporalWorkerManagerService.createWorkerFromDefinition and the
// dynamic require of @temporalio/worker). If it breaks after an update,
// check that workerOptions still reach Worker.create before adjusting it.
describe('nestjs-temporal-core passes the data converter to Worker.create', () => {
  it('hands the codec and the failure converter to the worker', async () => {
    const create = Worker.create as unknown as jest.Mock;
    create.mockReset();
    create.mockResolvedValue({});
    spyLogger();

    const wrapped = withYsocialPayloadCodec(
      realModule({
        workers: [
          {
            ...workerOf('main', { maxHeartbeatThrottleInterval: '15s' }),
            autoStart: true,
          },
        ],
      }),
      { [YSOCIAL_TEMPORAL_KEY_ENV]: newKeyBase64() }
    );
    const service = new (TemporalWorkerManagerService as any)(
      { getAllActivities: () => ({}) },
      optionsOf(wrapped),
      {}
    );
    await service.initializeMultipleWorkers();

    expect(create).toHaveBeenCalledTimes(1);
    const config = create.mock.calls[0][0];
    expect(config.taskQueue).toBe('main');
    expect(config.maxHeartbeatThrottleInterval).toBe('15s');
    expect(config.dataConverter.payloadCodecs).toHaveLength(1);
    expect(config.dataConverter.payloadCodecs[0]).toBeInstanceOf(
      YsocialPayloadCodec
    );
    expect(config.dataConverter.failureConverterPath).toMatch(
      /failure\.converter/
    );
  });
});

// Fake connection of the namespace calls.
const fakeConnection = (opts: {
  data?: Record<string, string> | null;
  describe?: jest.Mock;
}) => {
  const describeNamespace =
    opts.describe ||
    jest.fn(async () => ({
      namespaceInfo: opts.data === null ? undefined : { data: opts.data },
    }));
  const updateNamespace = jest.fn(async () => ({}));
  const connection = {
    workflowService: { describeNamespace, updateNamespace },
    withDeadline: (_deadline: number, fn: () => unknown) => fn(),
  } as any;
  return { connection, describeNamespace, updateNamespace };
};

describe('replaced TEMPORAL_CLIENT factory', () => {
  const clientWith = (connection: any, namespace = 'ns') =>
    ({ connection, options: { namespace } } as any);

  const factoryOf = (
    original: unknown,
    env: Record<string, string | undefined>
  ) => {
    const module = realModule();
    providerOf(module, TEMPORAL_CLIENT).useFactory = async () => original;
    return providerOf(withYsocialPayloadCodec(module, env), TEMPORAL_CLIENT)
      .useFactory as () => Promise<any>;
  };

  it('rejects without a check when the original returns null', async () => {
    const lines = spyLogger();
    const err = await factoryOf(null, {
      [YSOCIAL_TEMPORAL_KEY_ENV]: newKeyBase64(),
    })().catch((e) => e);
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('Temporal-Client fehlt');
    expect(err.message).toContain('ohne die Prüfung startet Postiz nicht');
    expect(lines).toEqual([`temporal codec check failed: ${err.message}`]);
  });

  it('rejects a missing client also without a key', async () => {
    spyLogger();
    await expect(factoryOf(null, {})()).rejects.toThrow(
      /Temporal-Client fehlt/
    );
  });

  it('returns a Client with the codec on the same connection and namespace', async () => {
    spyLogger();
    const { connection } = fakeConnection({ data: {} });
    const client = await factoryOf(clientWith(connection, 'prod'), {
      [YSOCIAL_TEMPORAL_KEY_ENV]: newKeyBase64(),
    })();
    expect(client).toBeInstanceOf(Client);
    expect(client.connection).toBe(connection);
    expect(client.options.namespace).toBe('prod');
    expect(client.options.loadedDataConverter.payloadCodecs).toHaveLength(1);
  });

  it('returns the original without a key', async () => {
    spyLogger();
    const original = clientWith(fakeConnection({ data: {} }).connection);
    expect(await factoryOf(original, {})()).toBe(original);
  });

  it('rejects when the check fails', async () => {
    const lines = spyLogger();
    const { connection } = fakeConnection({
      data: { [YSOCIAL_PAYLOAD_CODEC_MARKER]: 'deadbeef' },
    });
    await expect(
      factoryOf(clientWith(connection), {
        [YSOCIAL_TEMPORAL_KEY_ENV]: newKeyBase64(),
      })()
    ).rejects.toThrow(/passt nicht/);
    expect(
      lines.some((l) => l.startsWith('temporal codec check failed:'))
    ).toBe(true);
  });
});

describe('YsocialPayloadCodecCheck', () => {
  const SECRET_TEXT = 'access_token=EAAB-invented-error-text';
  const MARKER = YSOCIAL_PAYLOAD_CODEC_MARKER;
  const key = keyOf(newKeyBase64());
  const other = keyOf(newKeyBase64());

  const run = async (
    data: Record<string, string> | null,
    k: typeof key | undefined
  ) => {
    const lines = spyLogger();
    const fake = fakeConnection({ data });
    const check = new YsocialPayloadCodecCheck(fake.connection, 'ns', 0);
    let error: Error | undefined;
    let state: unknown;
    try {
      state = await check.run(k);
    } catch (err) {
      error = err as Error;
    }
    return { ...fake, lines, error, state };
  };

  it.each([
    ['no marker, no key', {}, undefined],
    ['no data at all', null, undefined],
    ['marker off', { [MARKER]: 'off' }, undefined],
    ['marker "off" with quotes', { [MARKER]: '"off"' }, undefined],
    ['empty marker', { [MARKER]: '' }, undefined],
    ['empty quoted marker', { [MARKER]: '""' }, undefined],
  ])('is off for %s', async (_name, data, k) => {
    const r = await run(data as any, k);
    expect(r.error).toBeUndefined();
    expect(r.state).toEqual({ codec: 'off' });
    expect(r.updateNamespace).not.toHaveBeenCalled();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^temporal codec off: /);
  });

  it.each([
    ['no marker', {}],
    ['marker off', { [MARKER]: '"off"' }],
  ])('marks the namespace with a key and %s', async (_name, data) => {
    const r = await run(data, key);
    expect(r.error).toBeUndefined();
    expect(r.state).toEqual({ codec: 'on', kid: key.kid, marked: true });
    expect(r.updateNamespace).toHaveBeenCalledTimes(1);
    expect(r.updateNamespace).toHaveBeenCalledWith({
      namespace: 'ns',
      updateInfo: { data: { [MARKER]: key.kid } },
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(`temporal codec on (key ${key.kid}`);
  });

  it('is on without update when the marker is the key id', async () => {
    const r = await run({ [MARKER]: key.kid }, key);
    expect(r.state).toEqual({ codec: 'on', kid: key.kid });
    expect(r.updateNamespace).not.toHaveBeenCalled();
    expect(r.lines[0]).toContain(`temporal codec on (key ${key.kid}`);
  });

  it('accepts the marker with quotes as the CLI stores it', async () => {
    const r = await run({ [MARKER]: `"${key.kid}"` }, key);
    expect(r.error).toBeUndefined();
    expect(r.updateNamespace).not.toHaveBeenCalled();
  });

  it('rejects another key id, naming both', async () => {
    const r = await run({ [MARKER]: other.kid }, key);
    expect(r.error).toBeInstanceOf(YsocialTemporalKeyError);
    expect(r.error!.message).toContain('passt nicht');
    expect(r.error!.message).toContain(other.kid);
    expect(r.error!.message).toContain(key.kid);
    expect(r.updateNamespace).not.toHaveBeenCalled();
    expect(r.lines).toEqual([
      `temporal codec check failed: ${r.error!.message}`,
    ]);
  });

  it('rejects a marker without key', async () => {
    const r = await run({ [MARKER]: key.kid }, undefined);
    expect(r.error).toBeInstanceOf(YsocialTemporalKeyError);
    expect(r.error!.message).toContain('fehlt');
    expect(r.error!.message).toContain(key.kid);
    expect(r.lines[0]).toMatch(/^temporal codec check failed: /);
  });

  it('fails after three failed reads of the namespace', async () => {
    const lines = spyLogger();
    const describe = jest.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${key.key.toString('base64')}`);
    });
    const fake = fakeConnection({ describe });
    const check = new YsocialPayloadCodecCheck(fake.connection, 'ns', 0);
    const err = await check.run(key).catch((e) => e);
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('Temporal nicht erreichbar');
    expect(describe).toHaveBeenCalledTimes(3);
    expect(fake.updateNamespace).not.toHaveBeenCalled();
    expect(err.message).not.toContain(key.key.toString('base64'));
    expect(lines[0]).toMatch(/^temporal codec check failed: /);
  });

  it.each([
    [14, 'Temporal nicht erreichbar', 'gRPC-Status 14'],
    [5, 'gibt es in Temporal nicht', 'gRPC-Status 5'],
  ])(
    'names the gRPC status %i of a failed read',
    async (code, text, status) => {
      const lines = spyLogger();
      const describe = jest.fn(async () => {
        throw Object.assign(new Error(`details ${SECRET_TEXT}`), { code });
      });
      const fake = fakeConnection({ describe });
      const check = new YsocialPayloadCodecCheck(fake.connection, 'ns', 0);
      const err = await check.run(key).catch((e) => e);
      expect(err).toBeInstanceOf(YsocialTemporalKeyError);
      expect(err.message).toContain(text);
      expect(err.message).toContain(status);
      expect(err.message).toContain('Namespace ns');
      expect(describe).toHaveBeenCalledTimes(3);
      for (const out of [err.message, ...lines]) {
        expect(out).not.toContain(SECRET_TEXT);
      }
      expect(lines).toEqual([`temporal codec check failed: ${err.message}`]);
    }
  );

  it('names the error class when the error has no numeric code', async () => {
    const lines = spyLogger();
    class BoomError extends Error {
      name = 'BoomError';
    }
    const describe = jest.fn(async () => {
      throw Object.assign(new BoomError(SECRET_TEXT), { code: 'ECONNREFUSED' });
    });
    const fake = fakeConnection({ describe });
    const err = await new YsocialPayloadCodecCheck(fake.connection, 'ns', 0)
      .run(key)
      .catch((e) => e);
    expect(err.message).toContain('Temporal nicht erreichbar');
    expect(err.message).toContain('(BoomError)');
    expect(err.message).not.toContain('gRPC-Status');
    for (const out of [err.message, ...lines]) {
      expect(out).not.toContain(SECRET_TEXT);
    }
  });

  it('fails when the marker cannot be set, naming the status only', async () => {
    const lines = spyLogger();
    const fake = fakeConnection({ data: {} });
    fake.updateNamespace.mockRejectedValue(
      Object.assign(new Error(SECRET_TEXT), { code: 7 })
    );
    const err = await new YsocialPayloadCodecCheck(fake.connection, 'ns', 0)
      .run(key)
      .catch((e) => e);
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('Markierung im Namespace ns nicht gesetzt');
    expect(err.message).toContain('gRPC-Status 7');
    expect(err.message).toContain('ohne sie startet Postiz nicht');
    for (const out of [err.message, ...lines]) {
      expect(out).not.toContain(SECRET_TEXT);
      expect(out).not.toContain(key.key.toString('base64'));
    }
    expect(lines).toEqual([`temporal codec check failed: ${err.message}`]);
  });

  it('runs normally when the second retry works', async () => {
    spyLogger();
    const describe = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({
        namespaceInfo: { data: { [MARKER]: key.kid } },
      });
    const fake = fakeConnection({ describe });
    const check = new YsocialPayloadCodecCheck(fake.connection, 'ns', 0);
    expect(await check.run(key)).toEqual({ codec: 'on', kid: key.kid });
    expect(describe).toHaveBeenCalledTimes(3);
  });

  it('never logs the key value', async () => {
    const r = await run({}, key);
    const base64 = key.key.toString('base64');
    for (const line of r.lines) {
      expect(line).not.toContain(base64);
    }
  });
});
