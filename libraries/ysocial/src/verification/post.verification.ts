import {
  createHubEvent,
  HubEvent,
  HubEventKind,
  HubEventValue,
} from '../events/hub.event';

/**
 * Rules of PostVerification (PLAN E22, W26, W34).
 *
 * The clock starts at the scheduled time of the post:
 * - ERROR: report at once.
 * - QUEUE 3 minutes after the scheduled time: "noch nicht veröffentlicht".
 * - PUBLISHED: check on the platform via postAnalytics. Found: "geprüft"
 *   with link. Not found 4 minutes after the scheduled time: "nicht
 *   auffindbar". Providers without a rule: "nicht prüfbar", no alarm.
 * - A reported post that goes out later, is deleted, becomes a draft again or
 *   gets a new date reports that, and the hub closes the alarm.
 *
 * Pure functions without I/O. They run inside the Temporal workflow, so no
 * Node.js imports here.
 */

export const VERIFY_WINDOW_MINUTES = 60;
export const VERIFY_WINDOW_MAX_MINUTES = 7 * 24 * 60;
export const NOT_PUBLISHED_AFTER_MS = 3 * 60_000;
export const NOT_FOUND_AFTER_MS = 4 * 60_000;
export const CHECK_EVERY_MS = 60_000;
// After a reported problem the workflow keeps watching for 24 hours.
export const FOLLOW_UP_FOR_MS = 24 * 60 * 60_000;
export const FOLLOW_UP_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60];

export type PostState = 'QUEUE' | 'PUBLISHED' | 'ERROR' | 'DRAFT';

// What the workflow reads from the database. No token, no post text.
export interface PostVerificationSnapshot {
  id: string;
  organizationId: string;
  integrationId: string;
  state: PostState;
  publishDate: string;
  deleted: boolean;
  releaseURL: string | null;
  // Error text of Postiz, already sanitized.
  error: string | null;
  integration: {
    providerIdentifier: string;
    customerId: string | null;
    disconnected: boolean;
  };
}

export type PlatformCheck =
  | { result: 'found' }
  | { result: 'not_found' }
  | { result: 'unverifiable'; reason: string };

export type ProblemKind =
  | 'post.failed'
  | 'post.not_published'
  | 'post.not_found';

export interface VerificationMemory {
  // Time of the first step, the follow-up horizon starts here.
  firstSeen?: number;
  // Scheduled time the memory belongs to. A new time starts a new check.
  publishDate?: string;
  problem?: ProblemKind;
  followUps: number;
  // How often each kind was reported for this scheduled time, for the ids.
  counts: Partial<Record<HubEventKind, number>>;
}

export type VerificationOutcome =
  | 'verified'
  | 'unverifiable'
  | 'deleted'
  | 'draft'
  | 'gave_up';

export interface VerificationStep {
  needsPlatformCheck: boolean;
  events: HubEvent[];
  memory: VerificationMemory;
  done: boolean;
  outcome?: VerificationOutcome;
  nextCheckAt?: number;
}

export const initialVerificationMemory = (): VerificationMemory => ({
  followUps: 0,
  counts: {},
});

const REASONS = {
  notPublished: 'Der Post steht 3 Minuten nach dem Termin noch auf „geplant“.',
  disconnected: 'Der Kanal ist getrennt oder muss neu verbunden werden.',
  notFound:
    'Postiz meldet „veröffentlicht“, die Plattform findet den Post 4 Minuten nach dem Termin nicht.',
  verified: 'Der Post ist auf der Plattform abrufbar.',
  deleted: 'Der Post wurde gelöscht.',
  draft: 'Der Post ist wieder ein Entwurf.',
  rescheduled: 'Der Post hat einen neuen Termin.',
  failed: 'Postiz meldet einen Fehler beim Veröffentlichen.',
};

const postEvent = (
  kind: HubEventKind,
  postId: string,
  snapshot: PostVerificationSnapshot | null,
  publishDate: string | undefined,
  memory: VerificationMemory,
  now: number,
  reason: string,
  data: Record<string, HubEventValue> = {}
): { event: HubEvent; memory: VerificationMemory } => {
  const count = (memory.counts[kind] || 0) + 1;
  const publishMs = publishDate ? Date.parse(publishDate) : 0;
  return {
    event: createHubEvent({
      kind,
      subject: { type: 'post', id: postId },
      stateKey: count > 1 ? `${publishMs}-${count}` : `${publishMs}`,
      occurredAt: new Date(now),
      postiz: snapshot
        ? {
            organizationId: snapshot.organizationId,
            integrationId: snapshot.integrationId,
            postId,
            customerId: snapshot.integration.customerId,
            providerIdentifier: snapshot.integration.providerIdentifier,
          }
        : { postId },
      reason,
      data: {
        ...(publishDate ? { publishDate } : {}),
        ...(snapshot ? { state: snapshot.state } : {}),
        ...data,
      },
    }),
    memory: { ...memory, counts: { ...memory.counts, [kind]: count } },
  };
};

const finish = (
  events: HubEvent[],
  memory: VerificationMemory,
  outcome: VerificationOutcome
): VerificationStep => ({
  needsPlatformCheck: false,
  events,
  memory,
  done: true,
  outcome,
});

const wait = (
  events: HubEvent[],
  memory: VerificationMemory,
  nextCheckAt: number
): VerificationStep => ({
  needsPlatformCheck: false,
  events,
  memory,
  done: false,
  nextCheckAt,
});

// Ends a check whose subject went away. Only a reported problem needs the
// message, otherwise there is nothing for the hub to close.
const resolve = (
  postId: string,
  snapshot: PostVerificationSnapshot | null,
  memory: VerificationMemory,
  now: number,
  resolution: 'deleted' | 'draft' | 'rescheduled'
) => {
  if (!memory.problem) {
    return { events: [] as HubEvent[], memory };
  }
  const reason =
    resolution === 'deleted'
      ? REASONS.deleted
      : resolution === 'draft'
      ? REASONS.draft
      : REASONS.rescheduled;
  const { event, memory: next } = postEvent(
    'post.resolved',
    postId,
    snapshot,
    memory.publishDate,
    memory,
    now,
    reason,
    { resolution }
  );
  return { events: [event], memory: { ...next, problem: undefined } };
};

// Next look after a reported problem: 1, 2, 5, 10, 15, 30, then every 60
// minutes, until the follow-up time is over.
const followUp = (
  events: HubEvent[],
  memory: VerificationMemory,
  now: number
): VerificationStep => {
  // A post moved days ahead starts its follow-up time at the new date.
  const start = Math.max(
    memory.firstSeen ?? now,
    memory.publishDate ? Date.parse(memory.publishDate) : 0
  );
  const horizon = start + FOLLOW_UP_FOR_MS;
  if (now >= horizon) {
    return finish(events, memory, 'gave_up');
  }
  const minutes =
    FOLLOW_UP_STEPS_MIN[
      Math.min(memory.followUps, FOLLOW_UP_STEPS_MIN.length - 1)
    ];
  return wait(
    events,
    { ...memory, followUps: memory.followUps + 1 },
    Math.min(horizon, now + minutes * 60_000)
  );
};

const report = (
  kind: ProblemKind,
  postId: string,
  snapshot: PostVerificationSnapshot,
  memory: VerificationMemory,
  now: number,
  reason: string
) => {
  const { event, memory: next } = postEvent(
    kind,
    postId,
    snapshot,
    snapshot.publishDate,
    memory,
    now,
    reason
  );
  return {
    events: [event],
    memory: { ...next, problem: kind, followUps: 0 },
  };
};

export const nextVerificationStep = (input: {
  postId: string;
  snapshot: PostVerificationSnapshot | null;
  platform?: PlatformCheck;
  now: number;
  memory: VerificationMemory;
}): VerificationStep => {
  const { postId, snapshot, platform, now } = input;
  let memory: VerificationMemory = {
    ...input.memory,
    firstSeen: input.memory.firstSeen ?? now,
  };

  if (!snapshot || snapshot.deleted) {
    const closed = resolve(postId, snapshot, memory, now, 'deleted');
    return finish(closed.events, closed.memory, 'deleted');
  }

  if (snapshot.state === 'DRAFT') {
    const closed = resolve(postId, snapshot, memory, now, 'draft');
    return finish(closed.events, closed.memory, 'draft');
  }

  // A new scheduled time starts a new check with new ids.
  if (memory.publishDate && memory.publishDate !== snapshot.publishDate) {
    const closed = resolve(postId, snapshot, memory, now, 'rescheduled');
    return wait(
      closed.events,
      {
        ...initialVerificationMemory(),
        firstSeen: now,
        publishDate: snapshot.publishDate,
        counts: {},
      },
      now
    );
  }
  memory = { ...memory, publishDate: snapshot.publishDate };

  const publishMs = Date.parse(snapshot.publishDate);
  if (publishMs > now) {
    return wait([], memory, publishMs);
  }

  if (snapshot.state === 'ERROR') {
    if (memory.problem === 'post.failed') {
      return followUp([], memory, now);
    }
    const reason = snapshot.error
      ? `${REASONS.failed} ${snapshot.error}`
      : REASONS.failed;
    const reported = report(
      'post.failed',
      postId,
      snapshot,
      memory,
      now,
      reason
    );
    return followUp(reported.events, reported.memory, now);
  }

  if (snapshot.state === 'QUEUE') {
    const deadline = publishMs + NOT_PUBLISHED_AFTER_MS;
    if (now < deadline) {
      return wait([], memory, Math.min(deadline, now + CHECK_EVERY_MS));
    }
    if (memory.problem) {
      return followUp([], memory, now);
    }
    const reason = snapshot.integration.disconnected
      ? `${REASONS.notPublished} ${REASONS.disconnected}`
      : REASONS.notPublished;
    const reported = report(
      'post.not_published',
      postId,
      snapshot,
      memory,
      now,
      reason
    );
    return followUp(reported.events, reported.memory, now);
  }

  // PUBLISHED
  if (!platform) {
    return {
      needsPlatformCheck: true,
      events: [],
      memory,
      done: false,
    };
  }

  if (platform.result === 'found') {
    const { event, memory: next } = postEvent(
      'post.verified',
      postId,
      snapshot,
      snapshot.publishDate,
      memory,
      now,
      REASONS.verified,
      {
        releaseURL: snapshot.releaseURL,
        check: 'postAnalytics',
      }
    );
    return finish([event], { ...next, problem: undefined }, 'verified');
  }

  if (platform.result === 'unverifiable') {
    const { event, memory: next } = postEvent(
      'post.unverifiable',
      postId,
      snapshot,
      snapshot.publishDate,
      memory,
      now,
      platform.reason,
      { releaseURL: snapshot.releaseURL }
    );
    return finish([event], { ...next, problem: undefined }, 'unverifiable');
  }

  const deadline = publishMs + NOT_FOUND_AFTER_MS;
  if (now < deadline) {
    return wait([], memory, deadline);
  }
  if (memory.problem === 'post.not_found') {
    return followUp([], memory, now);
  }
  const reported = report(
    'post.not_found',
    postId,
    snapshot,
    memory,
    now,
    REASONS.notFound
  );
  return followUp(reported.events, reported.memory, now);
};
