// Time lapse for ysocialVerifyPostWorkflowV102: deadlines after
// "Erneut versuchen". Same mock technique as ysocial.verify.post.workflow.spec.ts, the
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

import { ysocialVerifyPostWorkflowV102 } from './ysocial.verify.post.workflow.v1.0.2';
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
  return ysocialVerifyPostWorkflowV102({ postId: 'post-1' });
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

describe('ysocialVerifyPostWorkflowV102 in time lapse', () => {
  const U1 = T0 + 20_000;
  const R = T0 + 120 * MIN;

  it('does not report post.not_found for a retried post the platform finds after 2 minutes', async () => {
    // ERROR, "Erneut versuchen" 2 hours later, published a minute after that.
    const P = R + MIN;
    mockActivities.ysocialCheckPostOnPlatform.mockImplementation(async () => ({
      result: Date.now() < P + 2 * MIN ? 'not_found' : 'found',
    }));
    const result = await run((now) =>
      now >= P
        ? { state: 'PUBLISHED', updatedAt: iso(P) }
        : now >= R
        ? { state: 'QUEUE', updatedAt: iso(R) }
        : { state: 'ERROR', updatedAt: iso(U1) }
    );

    expect(mockEvents.map((e) => e.kind)).toEqual([
      'post.failed',
      'post.verified',
    ]);
    expect(mockEvents[1].at).toBeGreaterThanOrEqual(P + 2 * MIN);
    expect(mockEvents[1].at).toBeLessThan(P + 4 * MIN);
    expect(result.outcome).toBe('verified');
  });

  it('reports post.not_published 3 minutes after the retry when the post stays queued', async () => {
    await run((now) =>
      now >= R + 30 * MIN
        ? { deleted: true }
        : now >= R
        ? { state: 'QUEUE', updatedAt: iso(R) }
        : { state: 'ERROR', updatedAt: iso(U1) }
    );

    expect(mockEvents.map((e) => e.kind)).toEqual([
      'post.failed',
      'post.not_published',
      // The deletion at the end closes the alarm.
      'post.resolved',
    ]);
    expect(mockEvents[1].at).toBeGreaterThanOrEqual(R + 3 * MIN);
    expect(mockEvents[1].at).toBeLessThan(R + 4 * MIN + 1);
  });
});
