import { Injectable } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  parseWorkerStatus,
  toWorkerStatusView,
  YSOCIAL_WORKER_STATUS_KEY,
  YSOCIAL_WORKER_STATUS_TTL_S,
  YsocialStatusStore,
  YsocialWorkerStatusView,
} from '../../../../libraries/ysocial/src/worker/worker.status';
import { readYsocialWorkerConfig } from '../../../../libraries/ysocial/src/worker/worker.config';

// Reads the state the ysocial worker in the orchestrator writes to Redis.
@Injectable()
export class YsocialStatusService {
  protected statusStore: YsocialStatusStore =
    ioRedis as unknown as YsocialStatusStore;

  async getWorkerStatus(): Promise<YsocialWorkerStatusView> {
    let raw: string | null | undefined;
    try {
      raw = await this.statusStore.get(YSOCIAL_WORKER_STATUS_KEY);
    } catch (err) {
      return toWorkerStatusView(undefined, 'Redis nicht erreichbar');
    }

    // Backend and orchestrator share the environment of the container, so
    // a missing variable is the most likely reason for a missing report.
    const config = readYsocialWorkerConfig(process.env);
    const fallback = config.ok
      ? `keine Meldung des Workers in den letzten ${YSOCIAL_WORKER_STATUS_TTL_S} s`
      : config.problems.join(', ');

    return toWorkerStatusView(parseWorkerStatus(raw), fallback);
  }
}
