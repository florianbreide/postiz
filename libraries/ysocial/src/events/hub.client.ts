import { HubEvent } from './hub.event';
import { YSOCIAL_MODULE_VERSION } from '../ysocial.version';

/**
 * Sends one event to POST {HUB_INTERNAL_URL}/api/internal/events.
 *
 * The hub answers 202 and counts each id once (PLAN E35, PR 21). Every
 * attempt sends the same id in the body and in Idempotency-Key. Errors never
 * contain the token or the URL.
 */

export const HUB_EVENTS_PATH = '/api/internal/events';
export const HUB_REQUEST_TIMEOUT_MS = 10_000;

export interface HubClientConfig {
  hubUrl: string;
  hubToken: string;
}

export class HubDeliveryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'HubDeliveryError';
  }
}

// 4xx that will not get better by sending the same body again. 401, 403, 408
// and 429 stay retryable: a token or a hub can be fixed within the 24 hours
// the delivery retries.
const PERMANENT_STATUS = new Set([400, 404, 405, 410, 413, 415, 422]);

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{ status: number }>;

export const postHubEvent = async (
  event: HubEvent,
  config: HubClientConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = HUB_REQUEST_TIMEOUT_MS
): Promise<{ status: number; duplicate: boolean }> => {
  let status: number;
  try {
    const res = await fetchImpl(`${config.hubUrl}${HUB_EVENTS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.hubToken}`,
        'content-type': 'application/json',
        'idempotency-key': event.id,
        'user-agent': `ysocial-postiz/${YSOCIAL_MODULE_VERSION}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    throw new HubDeliveryError(`hub not reachable (${name})`, true);
  }

  if (status >= 200 && status < 300) {
    return { status, duplicate: false };
  }

  // A hub that already knows the id may answer 409. The event is there.
  if (status === 409) {
    return { status, duplicate: true };
  }

  throw new HubDeliveryError(
    `hub answered ${status}`,
    !PERMANENT_STATUS.has(status),
    status
  );
};
