// Time lapse for ysocialVerifyPostWorkflowV101: post.failed once per failed
// attempt. Same mock technique as ysocial.verify.post.workflow.spec.ts, the
// Temporal APIs are mocked and sleep() moves the fake clock forward.
const mockEvents: {
  at: number;
  kind: string;
  id: string;
  workflowId: string;
}[] = [];
const mockActivities = {
  ysocialLoadPostForVerification: jest.fn(),
  ysocialCheckPostOnPlatform: jest.fn(),
};

jest.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: jest.requireActual('@temporalio/workflow/lib/interfaces')
    .ParentClosePolicy,
  WorkflowIdReusePolicy:
    jest.requireActual('@temporalio/common').WorkflowIdReusePolicy,
  ActivityFailure: jest.requireActual('@temporalio/common').ActivityFailure,
  proxyActivities: () => mockActivities,
  sleep: async (ms: number) => {
    jest.setSystemTime(Date.now() + ms);
  },
  startChild: async (
    _type: string,
    options: { workflowId: string; args: any[] }
  ) => {
    const [event] = options.args;
    mockEvents.push({
      at: Date.now(),
      kind: event.kind,
      id: event.id,
      workflowId: options.workflowId,
    });
    return {};
  },
}));

import { ysocialVerifyPostWorkflowV101 } from './ysocial.verify.post.workflow.v1.0.1';
import { PostVerificationSnapshot } from '../../../../../libraries/ysocial/src/verification/post.verification';

const T0 = Date.parse('2026-10-26T09:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// The post as the database shows it at a given time.
type Timeline = (now: number) => Partial<{
  state: 'QUEUE' | 'PUBLISHED' | 'ERROR' | 'DRAFT';
  deleted: boolean;
  error: string | null;
  updatedAt: string;
}>;

const snapshotAt =
  (timeline: Timeline) =>
  (input: { postId: string }): PostVerificationSnapshot =>
    ({
      id: input.postId,
      organizationId: 'org-1',
      integrationId: 'int-1',
      state: 'QUEUE',
      publishDate: iso(T0),
      deleted: false,
      releaseURL: null,
      error: null,
      integration: {
        providerIdentifier: 'facebook',
        customerId: 'customer-1',
        disconnected: false,
      },
      ...timeline(Date.now()),
    } as PostVerificationSnapshot);

const run = (timeline: Timeline, startAt = T0 + 40_000) => {
  jest.setSystemTime(startAt);
  mockActivities.ysocialLoadPostForVerification.mockImplementation(
    snapshotAt(timeline)
  );
  return ysocialVerifyPostWorkflowV101({ postId: 'post-1' });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockEvents.length = 0;
  mockActivities.ysocialLoadPostForVerification.mockReset();
  mockActivities.ysocialCheckPostOnPlatform.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ysocialVerifyPostWorkflowV101 in time lapse', () => {
  it('reports a failed retry as a second post.failed with its own workflow id', async () => {
    const U1 = T0 + 20_000;
    const U2 = T0 + 20 * MIN;
    // ERROR, "Erneut versuchen" at +10 min (QUEUE), failed again at +20 min.
    const result = await run((now) =>
      now >= T0 + 40 * MIN
        ? { deleted: true }
        : now >= U2
        ? { state: 'ERROR', updatedAt: iso(U2) }
        : now >= T0 + 10 * MIN
        ? { state: 'QUEUE', updatedAt: iso(T0 + 10 * MIN) }
        : { state: 'ERROR', updatedAt: iso(U1) }
    );

    const failed = mockEvents.filter((e) => e.kind === 'post.failed');
    expect(failed.map((e) => e.id)).toEqual([
      `post.failed:post-1:${T0}-${U1}`,
      `post.failed:post-1:${T0}-${U2}`,
    ]);
    expect(failed[0].workflowId).toMatch(/^ysocial-event-post\.failed:/);
    expect(failed[1].workflowId).toMatch(/^ysocial-event-post\.failed:/);
    expect(failed[0].workflowId).not.toBe(failed[1].workflowId);
    expect(failed[1].at).toBeGreaterThanOrEqual(U2);
    expect(result.outcome).toBe('deleted');
  });

  it('reports a post that stays on ERROR once', async () => {
    const result = await run(() => ({
      state: 'ERROR',
      updatedAt: iso(T0 + 20_000),
    }));
    expect(
      mockEvents.filter((e) => e.kind === 'post.failed').map((e) => e.id)
    ).toEqual([`post.failed:post-1:${T0}-${T0 + 20_000}`]);
    expect(result.outcome).toBe('gave_up');
  });
});
