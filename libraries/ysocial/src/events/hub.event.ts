/**
 * Raw events from the fork to the hub (PLAN E21, E35).
 *
 * The fork detects, the hub decides who gets an alarm, stores and sends it.
 * An event carries a fixed id built from kind, subject and state. Every
 * retry of a delivery sends the same id, the hub counts each id once.
 * Events never carry tokens, post text or personal names (E35, E36).
 *
 * This file runs inside Temporal workflows too: no Node.js imports.
 */

export const HUB_EVENT_VERSION = 1;

export const HUB_EVENT_KINDS = ['ping'] as const;

export type HubEventKind = (typeof HUB_EVENT_KINDS)[number];

export type HubEventSubjectType = 'post' | 'channel' | 'system';

export type HubEventValue = string | number | boolean | null | string[];

export interface HubEventPostizIds {
  organizationId?: string;
  integrationId?: string;
  postId?: string;
  customerId?: string | null;
  providerIdentifier?: string;
}

export interface HubEvent {
  id: string;
  version: typeof HUB_EVENT_VERSION;
  kind: HubEventKind;
  occurredAt: string;
  source: 'postiz';
  subject: { type: HubEventSubjectType; id: string };
  postiz: HubEventPostizIds;
  // One short sentence, sanitized, at most HUB_EVENT_REASON_MAX characters.
  reason?: string;
  data?: Record<string, HubEventValue>;
}

export interface HubEventInput {
  kind: HubEventKind;
  subject: { type: HubEventSubjectType; id: string };
  // Distinguishes two states of the same subject, e.g. the publish date.
  stateKey: string;
  occurredAt: Date | string;
  postiz?: HubEventPostizIds;
  reason?: string;
  data?: Record<string, HubEventValue>;
}

export const HUB_EVENT_REASON_MAX = 300;
const HUB_EVENT_ID_MAX = 400;

// Keys that must never reach the hub, in any letter case.
const FORBIDDEN_DATA_KEYS = [
  'token',
  'refreshtoken',
  'accesstoken',
  'content',
  'settings',
  'custominstancedetails',
  'password',
  'secret',
];

export const buildEventId = (
  kind: HubEventKind,
  subjectId: string,
  stateKey: string
) => {
  const id = `${kind}:${subjectId}:${stateKey}`;
  if (
    !subjectId ||
    !stateKey ||
    /\s/.test(id) ||
    id.length > HUB_EVENT_ID_MAX
  ) {
    throw new Error(`ysocial: invalid event id for kind ${kind}`);
  }
  return id;
};

// Platform errors sometimes echo request URLs. Strip anything that looks like
// a credential before a text leaves the fork.
export const sanitizeReason = (reason?: string | null) => {
  if (!reason) {
    return undefined;
  }

  const clean = String(reason)
    .replace(
      /([?&](?:access_token|token|refresh_token|client_secret|key|signature)=)[^&\s"']+/gi,
      '$1***'
    )
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) {
    return undefined;
  }

  return clean.length > HUB_EVENT_REASON_MAX
    ? `${clean.slice(0, HUB_EVENT_REASON_MAX - 1)}…`
    : clean;
};

const assertSafeData = (data?: Record<string, HubEventValue>) => {
  for (const key of Object.keys(data || {})) {
    if (FORBIDDEN_DATA_KEYS.includes(key.toLowerCase())) {
      throw new Error(`ysocial: event data must not contain "${key}"`);
    }
  }
};

export const createHubEvent = (input: HubEventInput): HubEvent => {
  if (!HUB_EVENT_KINDS.includes(input.kind)) {
    throw new Error(`ysocial: unknown event kind ${input.kind}`);
  }
  assertSafeData(input.data);

  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : new Date(input.occurredAt).toISOString();
  const reason = sanitizeReason(input.reason);

  return {
    id: buildEventId(input.kind, input.subject.id, input.stateKey),
    version: HUB_EVENT_VERSION,
    kind: input.kind,
    occurredAt,
    source: 'postiz',
    subject: { type: input.subject.type, id: input.subject.id },
    postiz: { ...(input.postiz || {}) },
    ...(reason ? { reason } : {}),
    ...(input.data ? { data: { ...input.data } } : {}),
  };
};

// Workflow id of the delivery workflow. Starting it twice for the same event
// is rejected by Temporal, so an event is delivered once (E35).
export const deliveryWorkflowId = (eventId: string) =>
  `ysocial-event-${eventId}`;
