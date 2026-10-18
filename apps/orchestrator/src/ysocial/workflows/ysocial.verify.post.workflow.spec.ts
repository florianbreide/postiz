import { ActivityFailure } from '@temporalio/common';

// Time lapse for PostVerification (PR 17 QA 2): the Temporal APIs are mocked,
// sleep() moves the fake clock forward instead of waiting. @temporalio/testing
// is not a Postiz dependency (see YSOCIAL-PATCHES.md).
const mockEvents: { at: number; kind: string; id: string }[] = [];
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
  startChild: async (_type: string, options: { args: any[] }) => {
    const [event] = options.args;
    mockEvents.push({ at: Date.now(), kind: event.kind, id: event.id });
    return {};
  },
}));

import { ysocialVerifyPostWorkflow } from './ysocial.verify.post.workflow';
import { PostVerificationSnapshot } from '../../../../../libraries/ysocial/src/verification/post.verification';

const T0 = Date.parse('2026-10-26T09:00:00.000Z');
const MIN = 60_000;

// The post as the database shows it at a given time.
type Timeline = (now: number) => Partial<{
  state: 'QUEUE' | 'PUBLISHED' | 'ERROR' | 'DRAFT';
  deleted: boolean;
  error: string | null;
  releaseURL: string | null;
}>;

const snapshotAt =
  (timeline: Timeline) =>
  (input: { postId: string }): PostVerificationSnapshot =>
    ({
      id: input.postId,
      organizationId: 'org-1',
      integrationId: 'int-1',
      state: 'QUEUE',
      publishDate: new Date(T0).toISOString(),
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

// The dispatcher runs every minute, so the workflow starts up to one minute
// after the scheduled time.
const run = (timeline: Timeline, startAt = T0 + 40_000) => {
  jest.setSystemTime(startAt);
  mockActivities.ysocialLoadPostForVerification.mockImplementation(
    snapshotAt(timeline)
  );
  return ysocialVerifyPostWorkflow({ postId: 'post-1' });
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

describe('ysocialVerifyPostWorkflow in time lapse', () => {
  it('reports "noch nicht veröffentlicht" at the scheduled time + 3 min, at most 1 min later', async () => {
    const result = await run((now) =>
      now < T0 + 10 * MIN ? { state: 'QUEUE' } : { deleted: true }
    );

    const notPublished = mockEvents.find(
      (e) => e.kind === 'post.not_published'
    )!;
    expect(notPublished.at).toBeGreaterThanOrEqual(T0 + 3 * MIN);
    expect(notPublished.at).toBeLessThanOrEqual(T0 + 4 * MIN);
    expect(mockEvents.map((e) => e.kind)).toEqual([
      'post.not_published',
      'post.resolved',
    ]);
    expect(result.outcome).toBe('deleted');
    expect(mockActivities.ysocialCheckPostOnPlatform).not.toHaveBeenCalled();
  });

  it('reports ERROR in the first look', async () => {
    await run((now) =>
      now < T0 + 5 * MIN
        ? { state: 'ERROR', error: 'Session expired' }
        : { deleted: true }
    );
    expect(mockEvents[0]).toMatchObject({
      kind: 'post.failed',
      at: T0 + 40_000,
    });
  });

  it('verifies a published post with one platform call', async () => {
    mockActivities.ysocialCheckPostOnPlatform.mockResolvedValue({
      result: 'found',
    });
    const result = await run(() => ({
      state: 'PUBLISHED',
      releaseURL: 'https://www.facebook.com/1_2',
    }));
    expect(result).toEqual({
      postId: 'post-1',
      outcome: 'verified',
      platformChecks: 1,
    });
    expect(mockEvents.map((e) => e.kind)).toEqual(['post.verified']);
    expect(mockActivities.ysocialCheckPostOnPlatform).toHaveBeenCalledWith({
      postId: 'post-1',
    });
  });

  it('reports "nicht auffindbar" at + 4 min and closes it when the post shows up', async () => {
    mockActivities.ysocialCheckPostOnPlatform.mockImplementation(async () =>
      Date.now() < T0 + 7 * MIN ? { result: 'not_found' } : { result: 'found' }
    );
    const result = await run(() => ({ state: 'PUBLISHED' }));

    const notFound = mockEvents.find((e) => e.kind === 'post.not_found')!;
    expect(notFound.at).toBe(T0 + 4 * MIN);
    expect(mockEvents.map((e) => e.kind)).toEqual([
      'post.not_found',
      'post.verified',
    ]);
    expect(result.outcome).toBe('verified');
    // 40 s, 4 min, then follow-ups after 1 and 2 min.
    expect(result.platformChecks).toBe(4);
  });

  it('closes a "not published" alarm when the post goes out later', async () => {
    mockActivities.ysocialCheckPostOnPlatform.mockResolvedValue({
      result: 'found',
    });
    await run((now) =>
      now < T0 + 12 * MIN ? { state: 'QUEUE' } : { state: 'PUBLISHED' }
    );
    expect(mockEvents.map((e) => e.kind)).toEqual([
      'post.not_published',
      'post.verified',
    ]);
  });

  it('calls a provider without rule "nicht prüfbar" and stops', async () => {
    mockActivities.ysocialCheckPostOnPlatform.mockResolvedValue({
      result: 'unverifiable',
      reason: 'Für linkedin-page gibt es noch keine Prüfung.',
    });
    const result = await run(() => ({ state: 'PUBLISHED' }));
    expect(result.outcome).toBe('unverifiable');
    expect(mockEvents.map((e) => e.kind)).toEqual(['post.unverifiable']);
  });

  it('turns a failing platform call into "nicht prüfbar" instead of an alarm', async () => {
    mockActivities.ysocialCheckPostOnPlatform.mockRejectedValue(
      new ActivityFailure(
        'failed',
        'ysocialCheckPostOnPlatform',
        '1',
        2 as any,
        'worker'
      )
    );
    const result = await run(() => ({ state: 'PUBLISHED' }));
    expect(result.outcome).toBe('unverifiable');
    expect(mockEvents.map((e) => e.kind)).toEqual(['post.unverifiable']);
  });

  it('ends silently for a post deleted before its time', async () => {
    const result = await run(() => ({ deleted: true }));
    expect(result.outcome).toBe('deleted');
    expect(mockEvents).toEqual([]);
  });

  it('stops following an unsolved problem after 24 hours', async () => {
    const result = await run(() => ({ state: 'ERROR' }));
    expect(result.outcome).toBe('gave_up');
    expect(mockEvents.map((e) => e.kind)).toEqual(['post.failed']);
    expect(Date.now()).toBeLessThanOrEqual(T0 + 40_000 + 24 * 60 * MIN);
    expect(
      mockActivities.ysocialLoadPostForVerification.mock.calls.length
    ).toBeLessThan(40);
  });
});
