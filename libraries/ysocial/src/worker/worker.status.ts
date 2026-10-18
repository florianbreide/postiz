/**
 * Status of the ysocial worker, shared between orchestrator and backend.
 *
 * The worker runs in the orchestrator process, the status route in the
 * backend process. The orchestrator writes its state to Redis every
 * YSOCIAL_WORKER_HEARTBEAT_MS, the key expires after
 * YSOCIAL_WORKER_STATUS_TTL_S. No key means "Worker aus". Redis is the one
 * Postiz already uses, no table (HANDOVER §5).
 */

export const YSOCIAL_WORKER_STATUS_KEY = 'ysocial:worker:status';
export const YSOCIAL_WORKER_HEARTBEAT_MS = 30_000;
export const YSOCIAL_WORKER_STATUS_TTL_S = 90;

export type YsocialWorkerState = 'starting' | 'running' | 'off' | 'error';

export interface YsocialWorkerStatusRecord {
  state: YsocialWorkerState;
  // Short German text without values of variables or secrets.
  reason?: string;
  namespace?: string;
  taskQueue?: string;
  since: string;
  updatedAt: string;
  version: string;
}

export interface YsocialWorkerStatusView {
  running: boolean;
  label: 'Worker an' | 'Worker aus';
  state: YsocialWorkerState | 'unknown';
  reason?: string;
  namespace?: string;
  taskQueue?: string;
  since?: string;
  updatedAt?: string;
}

// The subset of ioredis that the status needs, so tests can pass a fake.
export interface YsocialStatusStore {
  get(key: string): Promise<string | null | undefined>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number
  ): Promise<unknown>;
}

const STATES: YsocialWorkerState[] = ['starting', 'running', 'off', 'error'];

export const writeWorkerStatus = async (
  store: YsocialStatusStore,
  record: YsocialWorkerStatusRecord
) => {
  await store.set(
    YSOCIAL_WORKER_STATUS_KEY,
    JSON.stringify(record),
    'EX',
    YSOCIAL_WORKER_STATUS_TTL_S
  );
};

export const parseWorkerStatus = (
  raw: string | null | undefined
): YsocialWorkerStatusRecord | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const value = JSON.parse(raw);
    if (!value || !STATES.includes(value.state)) {
      return undefined;
    }
    return value as YsocialWorkerStatusRecord;
  } catch (err) {
    return undefined;
  }
};

export const toWorkerStatusView = (
  record: YsocialWorkerStatusRecord | undefined,
  fallbackReason: string
): YsocialWorkerStatusView => {
  if (!record) {
    return {
      running: false,
      label: 'Worker aus',
      state: 'unknown',
      reason: fallbackReason,
    };
  }

  const running = record.state === 'running';
  return {
    running,
    label: running ? 'Worker an' : 'Worker aus',
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.namespace ? { namespace: record.namespace } : {}),
    ...(record.taskQueue ? { taskQueue: record.taskQueue } : {}),
    since: record.since,
    updatedAt: record.updatedAt,
  };
};
