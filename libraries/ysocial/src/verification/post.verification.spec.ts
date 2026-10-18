import {
  FOLLOW_UP_FOR_MS,
  initialVerificationMemory,
  nextVerificationStep,
  PlatformCheck,
  PostVerificationSnapshot,
  VerificationMemory,
  VerificationStep,
} from './post.verification';

// Invented post on an invented Y Social channel.
const T0 = Date.parse('2026-10-26T09:00:00.000Z');
const MIN = 60_000;

const post = (
  patch: Partial<PostVerificationSnapshot> = {}
): PostVerificationSnapshot => ({
  id: 'post-1',
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
  ...patch,
});

const step = (
  snapshot: PostVerificationSnapshot | null,
  now: number,
  memory: VerificationMemory = initialVerificationMemory(),
  platform?: PlatformCheck
) =>
  nextVerificationStep({ postId: 'post-1', snapshot, now, memory, platform });

const kinds = (s: VerificationStep) => s.events.map((e) => e.kind);

describe('PostVerification rules (E22)', () => {
  it('reports ERROR at once, with the sanitized Postiz error', () => {
    const s = step(
      post({ state: 'ERROR', error: 'Invalid OAuth token' }),
      T0 + 30_000
    );
    expect(kinds(s)).toEqual(['post.failed']);
    expect(s.events[0]).toMatchObject({
      id: `post.failed:post-1:${T0}`,
      subject: { type: 'post', id: 'post-1' },
      postiz: {
        organizationId: 'org-1',
        integrationId: 'int-1',
        postId: 'post-1',
        customerId: 'customer-1',
        providerIdentifier: 'facebook',
      },
      reason:
        'Postiz meldet einen Fehler beim Veröffentlichen. Invalid OAuth token',
      data: { publishDate: new Date(T0).toISOString(), state: 'ERROR' },
    });
    expect(s.done).toBe(false);
    expect(s.nextCheckAt).toBe(T0 + 30_000 + MIN);
  });

  it('waits while QUEUE is younger than 3 minutes and checks every minute', () => {
    const s = step(post(), T0 + 30_000);
    expect(s.events).toEqual([]);
    expect(s.nextCheckAt).toBe(T0 + 90_000);
    const late = step(post(), T0 + 2.5 * MIN);
    expect(late.nextCheckAt).toBe(T0 + 3 * MIN);
  });

  it('reports QUEUE 3 minutes after the scheduled time', () => {
    const s = step(post(), T0 + 3 * MIN);
    expect(kinds(s)).toEqual(['post.not_published']);
    expect(s.events[0].reason).toBe(
      'Der Post steht 3 Minuten nach dem Termin noch auf „geplant“.'
    );
  });

  it('names a disconnected channel in the reason', () => {
    const s = step(
      post({
        integration: {
          providerIdentifier: 'facebook',
          customerId: null,
          disconnected: true,
        },
      }),
      T0 + 3 * MIN
    );
    expect(s.events[0].reason).toContain('Kanal ist getrennt');
    expect(s.events[0].postiz.customerId).toBeNull();
  });

  it('asks for a platform check when PUBLISHED', () => {
    const s = step(post({ state: 'PUBLISHED' }), T0 + MIN);
    expect(s).toMatchObject({
      needsPlatformCheck: true,
      done: false,
      events: [],
    });
  });

  it('verifies a PUBLISHED post the platform finds, with link', () => {
    const s = step(
      post({ state: 'PUBLISHED', releaseURL: 'https://www.facebook.com/1_2' }),
      T0 + MIN,
      initialVerificationMemory(),
      { result: 'found' }
    );
    expect(s.done).toBe(true);
    expect(s.outcome).toBe('verified');
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      kind: 'post.verified',
      id: `post.verified:post-1:${T0}`,
      data: {
        releaseURL: 'https://www.facebook.com/1_2',
        check: 'postAnalytics',
        state: 'PUBLISHED',
      },
    });
  });

  it('waits until 4 minutes for a PUBLISHED post the platform does not find', () => {
    const early = step(
      post({ state: 'PUBLISHED' }),
      T0 + MIN,
      initialVerificationMemory(),
      { result: 'not_found' }
    );
    expect(early.events).toEqual([]);
    expect(early.nextCheckAt).toBe(T0 + 4 * MIN);

    const late = step(
      post({ state: 'PUBLISHED' }),
      T0 + 4 * MIN,
      early.memory,
      { result: 'not_found' }
    );
    expect(kinds(late)).toEqual(['post.not_found']);
    expect(late.done).toBe(false);
  });

  it('closes the alarm when a reported post goes out later', () => {
    const reported = step(post(), T0 + 3 * MIN);
    const stillQueued = step(post(), reported.nextCheckAt!, reported.memory);
    expect(stillQueued.events).toEqual([]);
    const published = step(
      post({ state: 'PUBLISHED', releaseURL: 'https://www.facebook.com/1_2' }),
      T0 + 9 * MIN,
      stillQueued.memory,
      { result: 'found' }
    );
    expect(kinds(published)).toEqual(['post.verified']);
    expect(published.memory.problem).toBeUndefined();
    expect(published.done).toBe(true);
  });

  it('turns "not published" into "failed" when Postiz gives up, but not back', () => {
    const queued = step(post(), T0 + 3 * MIN);
    const failed = step(post({ state: 'ERROR' }), T0 + 8 * MIN, queued.memory);
    expect(kinds(failed)).toEqual(['post.failed']);
    const retried = step(post(), T0 + 20 * MIN, failed.memory);
    expect(retried.events).toEqual([]);
    const failedAgain = step(
      post({ state: 'ERROR' }),
      T0 + 30 * MIN,
      retried.memory
    );
    expect(failedAgain.events).toEqual([]);
  });

  it('reports nothing for a deleted post without a problem', () => {
    const s = step(post({ deleted: true }), T0 + MIN);
    expect(s).toMatchObject({ done: true, outcome: 'deleted', events: [] });
    expect(step(null, T0 + MIN)).toMatchObject({
      done: true,
      outcome: 'deleted',
    });
  });

  it('closes the alarm when a reported post is deleted', () => {
    const reported = step(post(), T0 + 3 * MIN);
    const s = step(post({ deleted: true }), T0 + 5 * MIN, reported.memory);
    expect(kinds(s)).toEqual(['post.resolved']);
    expect(s.events[0].data).toMatchObject({ resolution: 'deleted' });
    expect(s.done).toBe(true);
  });

  it('closes the alarm for a draft', () => {
    const reported = step(post(), T0 + 3 * MIN);
    const s = step(post({ state: 'DRAFT' }), T0 + 5 * MIN, reported.memory);
    expect(kinds(s)).toEqual(['post.resolved']);
    expect(s.events[0].data).toMatchObject({ resolution: 'draft' });
  });

  it('reports a provider without check as "nicht prüfbar", which is no alarm', () => {
    const s = step(
      post({
        state: 'PUBLISHED',
        integration: {
          providerIdentifier: 'linkedin-page',
          customerId: null,
          disconnected: false,
        },
      }),
      T0 + MIN,
      initialVerificationMemory(),
      {
        result: 'unverifiable',
        reason: 'Für linkedin-page gibt es noch keine Prüfung.',
      }
    );
    expect(kinds(s)).toEqual(['post.unverifiable']);
    expect(s.events[0].reason).toBe(
      'Für linkedin-page gibt es noch keine Prüfung.'
    );
    expect(s).toMatchObject({ done: true, outcome: 'unverifiable' });
  });

  it('starts over with new ids when the post gets a new date', () => {
    const reported = step(post(), T0 + 3 * MIN);
    const moved = post({ publishDate: new Date(T0 + 60 * MIN).toISOString() });
    const s = step(moved, T0 + 5 * MIN, reported.memory);
    expect(kinds(s)).toEqual(['post.resolved']);
    expect(s.events[0].data).toMatchObject({ resolution: 'rescheduled' });

    const waiting = step(moved, T0 + 5 * MIN, s.memory);
    expect(waiting.events).toEqual([]);
    expect(waiting.nextCheckAt).toBe(T0 + 60 * MIN);

    const again = step(moved, T0 + 63 * MIN, waiting.memory);
    expect(again.events[0].id).toBe(
      `post.not_published:post-1:${T0 + 60 * MIN}`
    );
  });

  it('gives a second report of the same kind its own id', () => {
    const first = step(post(), T0 + 3 * MIN);
    const published = step(
      post({ state: 'PUBLISHED' }),
      T0 + 6 * MIN,
      first.memory,
      {
        result: 'not_found',
      }
    );
    expect(kinds(published)).toEqual(['post.not_found']);
    const ids = [...first.events, ...published.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('follows a problem with growing pauses for 24 hours, then stops', () => {
    let s = step(post(), T0 + 3 * MIN);
    const pauses: number[] = [];
    let now = T0 + 3 * MIN;
    while (!s.done) {
      pauses.push((s.nextCheckAt! - now) / MIN);
      now = s.nextCheckAt!;
      s = step(post(), now, s.memory);
      expect(s.events).toEqual([]);
    }
    expect(pauses.slice(0, 8)).toEqual([1, 2, 5, 10, 15, 30, 60, 60]);
    expect(s.outcome).toBe('gave_up');
    expect(now).toBeLessThanOrEqual(T0 + 3 * MIN + FOLLOW_UP_FOR_MS);
    expect(pauses.length).toBeLessThan(40);
  });

  it('checks an old post at once in a run by hand with a larger window', () => {
    const old = post({
      state: 'PUBLISHED',
      publishDate: new Date(T0 - 2 * 24 * 60 * MIN).toISOString(),
    });
    expect(step(old, T0).needsPlatformCheck).toBe(true);
    expect(
      step(old, T0, initialVerificationMemory(), { result: 'found' }).outcome
    ).toBe('verified');
  });

  it('never puts a token or post text into an event', () => {
    const s = step(
      post({
        state: 'ERROR',
        error: 'GET /v23.0/1_2?access_token=EAAGsecret failed',
      }),
      T0 + MIN
    );
    const text = JSON.stringify(s.events);
    expect(text).not.toContain('EAAGsecret');
    expect(text).not.toMatch(/"content"|"token"|"settings"/);
  });
});
