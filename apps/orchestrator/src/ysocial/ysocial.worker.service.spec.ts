import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { restartDelay, YsocialWorkerService } from './ysocial.worker.service';
import { YsocialActivities } from './ysocial.activities';
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

  constructor() {
    super(new YsocialActivities());
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

  it('waits longer after each failure, at most 10 minutes', () => {
    expect(restartDelay(1)).toBe(30_000);
    expect(restartDelay(2)).toBe(60_000);
    expect(restartDelay(10)).toBe(600_000);
  });
});
