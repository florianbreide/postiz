import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { NativeConnection, Worker, WorkerOptions } from '@temporalio/worker';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  readYsocialWorkerConfig,
  YSOCIAL_MAX_CONCURRENT_ACTIVITIES,
  YsocialWorkerConfig,
} from '../../../../libraries/ysocial/src/worker/worker.config';
import {
  writeWorkerStatus,
  YSOCIAL_WORKER_HEARTBEAT_MS,
  YsocialStatusStore,
  YsocialWorkerState,
  YsocialWorkerStatusRecord,
} from '../../../../libraries/ysocial/src/worker/worker.status';
import { sanitizeReason } from '../../../../libraries/ysocial/src/events/hub.event';
import { YSOCIAL_MODULE_VERSION } from '../../../../libraries/ysocial/src/ysocial.version';
import {
  buildYsocialActivities,
  YsocialActivities,
} from './ysocial.activities';

const RESTART_MIN_MS = 30_000;
const RESTART_MAX_MS = 10 * 60_000;
const SHUTDOWN_WAIT_MS = 15_000;

export const restartDelay = (attempt: number) =>
  Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.max(0, attempt - 1));

const describeError = (err: unknown) =>
  sanitizeReason(
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  )?.slice(0, 200) || 'unbekannter Fehler';

export const ysocialWorkerOptions = (
  connection: NativeConnection,
  config: YsocialWorkerConfig,
  activities: YsocialActivities
): WorkerOptions => ({
  connection,
  namespace: config.namespace,
  taskQueue: config.taskQueue,
  workflowsPath: require.resolve('./workflows'),
  activities: buildYsocialActivities(activities),
  maxConcurrentActivityTaskExecutions: YSOCIAL_MAX_CONCURRENT_ACTIVITIES,
  maxConcurrentWorkflowTaskExecutions: 10,
  // Few, short workflows. A small cache keeps the memory low (PR 16 QA 5).
  maxCachedWorkflows: 100,
  shutdownGraceTime: '10 seconds',
});

/**
 * Own Temporal worker in the orchestrator process (PLAN E33, R24).
 *
 * - Namespace from YSOCIAL_TEMPORAL_NAMESPACE, queue ysocial-postiz, only the
 *   workflows in ./workflows and the activities of YsocialActivities.
 * - Missing configuration: the worker does not start, Postiz runs on, the
 *   status says "Worker aus" with the reason.
 * - No error of this worker ever ends the orchestrator. A failed start or a
 *   crashed worker is logged and started again with a growing pause.
 * - The state goes to Redis every 30 s for GET /ysocial/status (backend).
 */
@Injectable()
export class YsocialWorkerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly _logger = new Logger('ysocial');
  protected statusStore: YsocialStatusStore =
    ioRedis as unknown as YsocialStatusStore;

  private _worker?: Worker;
  private _connection?: NativeConnection;
  private _heartbeat?: NodeJS.Timeout;
  private _pause?: { timer: NodeJS.Timeout; resolve: () => void };
  private _stopping = false;
  private _done?: Promise<void>;
  private _status?: YsocialWorkerStatusRecord;

  constructor(private _activities: YsocialActivities) {}

  onApplicationBootstrap() {
    // Not awaited: bundling the workflows takes seconds and must not hold up
    // the start of Postiz.
    this._done = this.run().catch((err) => {
      this._logger.error(`ysocial worker stopped: ${describeError(err)}`);
    });
  }

  async beforeApplicationShutdown() {
    this._stopping = true;
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
    }
    if (this._pause) {
      clearTimeout(this._pause.timer);
      this._pause.resolve();
    }
    try {
      if (this._worker?.getState() === 'RUNNING') {
        this._worker.shutdown();
      }
      // A connect that hangs must not hold up the shutdown of Postiz.
      await Promise.race([
        this._done,
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
      ]);
    } catch (err) {
      this._logger.warn(`ysocial worker shutdown: ${describeError(err)}`);
    }
    await this.closeConnection();
    await this.setStatus('off', 'Orchestrator wird beendet');
  }

  // Exposed for tests: resolves when the worker loop has ended.
  get done() {
    return this._done;
  }

  async run() {
    const result = readYsocialWorkerConfig(process.env);
    this.startHeartbeat();

    if (!result.ok) {
      const reason = result.problems.join(', ');
      this._logger.warn(`ysocial worker off: ${reason}`);
      await this.setStatus('off', reason);
      return;
    }

    let attempt = 0;
    while (!this._stopping) {
      const config = result.config!;
      try {
        await this.setStatus('starting', undefined, config);
        this._connection = await this.connect(config);
        this._worker = await this.createWorker(this._connection, config);
        await this.setStatus('running', undefined, config);
        attempt = 0;
        this._logger.log(
          `ysocial worker running (namespace ${config.namespace}, queue ${config.taskQueue})`
        );

        await this._worker.run();
        if (this._stopping) {
          return;
        }
        throw new Error('worker ended without shutdown');
      } catch (err) {
        this._worker = undefined;
        await this.closeConnection();
        if (this._stopping) {
          return;
        }

        const delay = restartDelay(++attempt);
        const reason = describeError(err);
        this._logger.error(
          `ysocial worker failed: ${reason}. Next start in ${Math.round(
            delay / 1000
          )} s`
        );
        await this.setStatus('error', reason, config);
        await this.pause(delay);
      }
    }
  }

  protected connect(config: YsocialWorkerConfig) {
    return NativeConnection.connect({
      address: config.temporalAddress,
      ...(config.temporalTls ? { tls: true } : {}),
      ...(config.temporalApiKey ? { apiKey: config.temporalApiKey } : {}),
    });
  }

  protected createWorker(
    connection: NativeConnection,
    config: YsocialWorkerConfig
  ) {
    return Worker.create(
      ysocialWorkerOptions(connection, config, this._activities)
    );
  }

  private startHeartbeat() {
    this._heartbeat = setInterval(() => {
      if (this._status) {
        void this.writeStatus(this._status);
      }
    }, YSOCIAL_WORKER_HEARTBEAT_MS);
    this._heartbeat.unref();
  }

  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this._pause = { timer, resolve };
    });
  }

  private async closeConnection() {
    const connection = this._connection;
    this._connection = undefined;
    try {
      await connection?.close();
    } catch (err) {
      /** already closed **/
    }
  }

  private async setStatus(
    state: YsocialWorkerState,
    reason?: string,
    config?: YsocialWorkerConfig
  ) {
    const now = new Date().toISOString();
    const since =
      this._status && this._status.state === state ? this._status.since : now;
    this._status = {
      state,
      ...(reason ? { reason } : {}),
      ...(config
        ? { namespace: config.namespace, taskQueue: config.taskQueue }
        : {}),
      since,
      updatedAt: now,
      version: YSOCIAL_MODULE_VERSION,
    };
    await this.writeStatus(this._status);
  }

  private async writeStatus(record: YsocialWorkerStatusRecord) {
    try {
      await writeWorkerStatus(this.statusStore, {
        ...record,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      this._logger.warn(
        `ysocial worker status not saved: ${describeError(err)}`
      );
    }
  }
}
