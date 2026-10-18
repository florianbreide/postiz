// The test replaces connect and createWorker. Without this mock the native
// Temporal core would load and keep the Jest worker from exiting in time.
jest.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: jest.fn() },
  Worker: { create: jest.fn() },
}));

// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { restartDelay, YsocialWorkerService } from './ysocial.worker.service';
import { YsocialActivities } from './ysocial.activities';
import { ysocialSchedules } from './ysocial.schedules';
import {
  YSOCIAL_WORKER_STATUS_KEY,
  YsocialWorkerStatusRecord,
} from '../../../../libraries/ysocial/src/worker/worker.status';
import { YsocialWorkerConfig } from '../../../../libraries/ysocial/src/worker/worker.config';

// A worker whose run() resolves on shutdown, like the real one.
class FakeWorker {
  state = 'RUNNING';
  private _stop?: () => void;
  run = jest.fn(() => new Promise<void>((resolve) => (this._stop = resolve)));
  getState = () => this.state;
  shutdown = jest.fn(() => {
    this.state = 'STOPPED';
    this._stop?.();
  });
}

class TestWorkerService extends YsocialWorkerService {
  writes: YsocialWorkerStatusRecord[] = [];
  connectCalls = 0;
  connectFailures = 0;
  worker = new FakeWorker();
  createdWith?: YsocialWorkerConfig;

  scheduleCreate = jest.fn().mockResolvedValue({});
  temporal = {
    get: jest.fn(async () => ({
      schedule: { create: this.scheduleCreate, getHandle: jest.fn() },
    })),
  };

  constructor() {
    super(
      new YsocialActivities({} as any, {} as any, {} as any),
      undefined as any
    );
    (this as any)._temporal = this.temporal;
    this.statusStore = {
      get: async () => undefined,
      set: async (key: string, value: string) => {
        expect(key).toBe(YSOCIAL_WORKER_STATUS_KEY);
        this.writes.push(JSON.parse(value));
        return 'OK';
      },
    };
  }

  protected async connect() {
    this.connectCalls++;
    if (this.connectFailures > 0) {
      this.connectFailures--;
      throw new Error('connection refused');
    }
    return { close: jest.fn() } as unknown as NativeConnection;
  }

  protected async createWorker(
    _connection: NativeConnection,
    config: YsocialWorkerConfig
  ) {
    this.createdWith = config;
    return this.worker as unknown as Worker;
  }

  get lastStatus() {
    return this.writes[this.writes.length - 1];
  }
}

const configured = {
  HUB_INTERNAL_URL: 'http://hub-web:3000',
  HUB_INTERNAL_TOKEN: randomBytes(32).toString('hex'),
  YSOCIAL_TEMPORAL_NAMESPACE: 'ysocial',
};

describe('YsocialWorkerService', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.HUB_INTERNAL_URL;
    delete process.env.HUB_INTERNAL_TOKEN;
    delete process.env.YSOCIAL_TEMPORAL_NAMESPACE;
    delete process.env.YSOCIAL_WORKER_ENABLED;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('does not start without HUB_INTERNAL_TOKEN and reports "off"', async () => {
    process.env = { ...process.env, ...configured };
    delete process.env.HUB_INTERNAL_TOKEN;
    const service = new TestWorkerService();
    service.onApplicationBootstrap();
    await service.done;

    expect(service.connectCalls).toBe(0);
    expect(service.lastStatus).toMatchObject({
      state: 'off',
      reason: 'HUB_INTERNAL_TOKEN fehlt oder ist kürzer als 32 Zeichen',
    });
    expect(JSON.stringify(service.writes)).not.toContain(
      configured.HUB_INTERNAL_URL
    );
    await service.beforeApplicationShutdown();
  });

  it('names every missing variable', async () => {
    const service = new TestWorkerService();
    await service.run();
    expect(service.lastStatus.reason).toBe(
      'HUB_INTERNAL_URL fehlt, HUB_INTERNAL_TOKEN fehlt oder ist kürzer als 32 Zeichen, YSOCIAL_TEMPORAL_NAMESPACE fehlt'
    );
    await service.beforeApplicationShutdown();
  });

  it('stays off with YSOCIAL_WORKER_ENABLED=false', async () => {
    process.env = {
      ...process.env,
      ...configured,
      YSOCIAL_WORKER_ENABLED: 'false',
    };
    const service = new TestWorkerService();
    await service.run();
    expect(service.connectCalls).toBe(0);
    expect(service.lastStatus).toMatchObject({
      state: 'off',
      reason: 'YSOCIAL_WORKER_ENABLED=false',
    });
    await service.beforeApplicationShutdown();
  });

  it('runs in the ysocial namespace on queue ysocial-postiz and stops on shutdown', async () => {
    process.env = { ...process.env, ...configured };
    const service = new TestWorkerService();
    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.createdWith).toMatchObject({
      namespace: 'ysocial',
      taskQueue: 'ysocial-postiz',
    });
    expect(service.lastStatus).toMatchObject({
      state: 'running',
      namespace: 'ysocial',
      taskQueue: 'ysocial-postiz',
    });

    await service.beforeApplicationShutdown();
    expect(service.worker.shutdown).toHaveBeenCalled();
    expect(service.lastStatus).toMatchObject({
      state: 'off',
      reason: 'Orchestrator wird beendet',
    });
  });

  it('survives a failed start and tries again after a pause', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env = { ...process.env, ...configured };
    const service = new TestWorkerService();
    service.connectFailures = 1;

    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.lastStatus).toMatchObject({
      state: 'error',
      reason: 'Error: connection refused',
    });

    await jest.advanceTimersByTimeAsync(restartDelay(1));
    expect(service.connectCalls).toBe(2);
    expect(service.lastStatus.state).toBe('running');

    await service.beforeApplicationShutdown();
  });

  it('starts again when the worker crashes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env = { ...process.env, ...configured };
    const service = new TestWorkerService();
    service.worker.run.mockRejectedValueOnce(new Error('worker crashed'));

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.lastStatus).toMatchObject({
      state: 'error',
      reason: 'Error: worker crashed',
    });

    await jest.advanceTimersByTimeAsync(restartDelay(1));
    expect(service.lastStatus.state).toBe('running');
    await service.beforeApplicationShutdown();
  });

  it('refreshes the status in Redis every 30 s', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const service = new TestWorkerService();
    await service.run();
    const before = service.writes.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(service.writes.length).toBe(before + 1);
    expect(service.lastStatus.state).toBe('off');
    await service.beforeApplicationShutdown();
  });

  it('creates the schedules once the worker runs', async () => {
    process.env = { ...process.env, ...configured };
    const service = new TestWorkerService();
    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.scheduleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'ysocial-post-verification' })
    );
    expect(service.lastStatus).toMatchObject({
      state: 'running',
      schedules: 'ready',
    });
    await service.beforeApplicationShutdown();
  });

  it('keeps the worker running and tries again when the schedules fail', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env = { ...process.env, ...configured };
    const service = new TestWorkerService();
    service.scheduleCreate.mockRejectedValueOnce(
      new Error('namespace not found')
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(service.lastStatus.state).toBe('running');
    expect(service.scheduleCreate).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    // First try failed at the first schedule, the second creates all.
    expect(service.scheduleCreate).toHaveBeenCalledTimes(
      1 + ysocialSchedules('ysocial-postiz').length
    );
    expect(service.lastStatus).toMatchObject({
      state: 'running',
      schedules: 'ready',
    });
    await service.beforeApplicationShutdown();
  });

  it('waits longer after each failure, at most 10 minutes', () => {
    expect(restartDelay(1)).toBe(30_000);
    expect(restartDelay(2)).toBe(60_000);
    expect(restartDelay(10)).toBe(600_000);
  });
});
