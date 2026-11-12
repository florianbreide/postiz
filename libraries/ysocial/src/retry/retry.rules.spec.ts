import {
  ACTOR_MAX_LENGTH,
  parseActor,
  postTaskQueue,
  retryDecision,
  RetryPostRow,
  unclearOutcome,
} from './retry.rules';

// Post.error as Postiz stores a Temporal failure (invented ids and hosts).
const failure = (
  cause: Record<string, unknown>,
  activityType: string,
  extra: Record<string, unknown> = {}
) =>
  JSON.stringify({
    cause,
    activityType,
    activityId: '7',
    retryState: 'NON_RETRYABLE_FAILURE',
    identity: 'worker@host',
    ...extra,
  });

const outcome = (post: {
  releaseId?: string | null;
  releaseURL?: string | null;
  error: string | null;
}) => unclearOutcome({ releaseId: null, releaseURL: null, ...post });

const badBody = (activityType: string) =>
  failure(
    {
      type: 'bad_body',
      nonRetryable: true,
      details: [{ identifier: 'facebook' }],
    },
    activityType
  );
const refreshToken = (activityType: string) =>
  failure({ type: 'refresh_token', nonRetryable: true }, activityType);

describe('unclearOutcome: nothing went out (no confirmation needed)', () => {
  it.each(['No Post', 'Refresh channel needed', 'Channel disabled'])(
    'error "%s" with an empty releaseURL',
    (error) => {
      expect(outcome({ releaseURL: null, error })).toBeUndefined();
      expect(outcome({ releaseURL: '', error })).toBeUndefined();
    }
  );

  it('refresh_token in postSocialPending', () => {
    expect(
      outcome({
        releaseURL: null,
        error: refreshToken('postSocialPending'),
      })
    ).toBeUndefined();
  });

  it('refresh_token in postSocial', () => {
    expect(
      outcome({ releaseURL: null, error: refreshToken('postSocial') })
    ).toBeUndefined();
  });
});

describe('unclearOutcome: unconfirmed', () => {
  const unconfirmed = (error: string | null) =>
    outcome({ releaseURL: null, error });

  it.each([
    'Could not confirm the post status',
    'Could not publish after several attempts',
    'Already posted',
  ])('error "%s"', (error) => {
    expect(unconfirmed(error)).toBe('unconfirmed');
  });

  it('a timeout (cause.timeoutType)', () => {
    expect(
      unconfirmed(
        failure(
          {
            lastHeartbeatDetails: 'postSocialPending: provider call',
            timeoutType: 'START_TO_CLOSE',
          },
          'postSocialPending'
        )
      )
    ).toBe('unconfirmed');
  });

  // bad_body proves nothing: 500, 429 and network errors become BadBody.
  it.each([
    'postSocialPending',
    'postSocial',
    'checkPostStatus',
    'finalizePost',
  ])('bad_body in %s', (activity) => {
    expect(unconfirmed(badBody(activity))).toBe('unconfirmed');
  });

  it('the Facebook story text as bad_body in checkPostStatus', () => {
    const text =
      'Facebook may have already published part of the story, please check your page before posting again to avoid duplicates';
    expect(
      unconfirmed(
        failure(
          { type: 'bad_body', nonRetryable: true, message: text },
          'checkPostStatus',
          { message: text }
        )
      )
    ).toBe('unconfirmed');
  });

  it('updatePost with refresh_token or another cause', () => {
    expect(unconfirmed(refreshToken('updatePost'))).toBe('unconfirmed');
    expect(unconfirmed(failure({ type: 'other' }, 'updatePost'))).toBe(
      'unconfirmed'
    );
  });

  // updatePost runs after the publish call, so even bad_body there does not
  // prove that nothing went out.
  it('updatePost with bad_body', () => {
    expect(unconfirmed(badBody('updatePost'))).toBe('unconfirmed');
  });

  it('refresh_token in checkPostStatus', () => {
    expect(unconfirmed(refreshToken('checkPostStatus'))).toBe('unconfirmed');
  });

  it('refresh_token in finalizePost', () => {
    expect(unconfirmed(refreshToken('finalizePost'))).toBe('unconfirmed');
  });

  it('an empty or null error', () => {
    expect(unconfirmed('')).toBe('unconfirmed');
    expect(unconfirmed('   ')).toBe('unconfirmed');
    expect(unconfirmed(null)).toBe('unconfirmed');
  });

  it('JSON that cannot be read', () => {
    expect(unconfirmed('{"cause":{"type":"bad_body"')).toBe('unconfirmed');
  });

  it('JSON without a cause', () => {
    expect(
      unconfirmed(JSON.stringify({ activityType: 'postSocialPending' }))
    ).toBe('unconfirmed');
    expect(unconfirmed('null')).toBe('unconfirmed');
    expect(unconfirmed('42')).toBe('unconfirmed');
  });

  it('an unknown error text', () => {
    expect(unconfirmed('socket hang up')).toBe('unconfirmed');
  });
});

describe('unclearOutcome: published', () => {
  const releaseURL = 'https://example.com/ysocial-test/posts/1';

  it('a set releaseURL', () => {
    expect(outcome({ releaseURL, error: null })).toBe('published');
  });

  it('a set releaseURL together with bad_body (PublishedWithError)', () => {
    expect(outcome({ releaseURL, error: badBody('finalizePost') })).toBe(
      'published'
    );
  });

  it('a set releaseURL together with "No Post"', () => {
    expect(outcome({ releaseURL, error: 'No Post' })).toBe('published');
  });

  it('a set releaseId with an empty releaseURL', () => {
    expect(outcome({ releaseId: 'rel-1', releaseURL: null, error: null })).toBe(
      'published'
    );
    expect(
      outcome({ releaseId: 'rel-1', releaseURL: '', error: 'No Post' })
    ).toBe('published');
  });

  it.each([
    ['bad_body', badBody('postComment')],
    ['refresh_token', refreshToken('postComment')],
    ['a timeout', failure({ timeoutType: 'START_TO_CLOSE' }, 'postComment')],
  ])('postComment with %s and empty releaseId and releaseURL', (_n, error) => {
    expect(outcome({ error })).toBe('published');
  });
});

describe('retryDecision', () => {
  const post = (patch: Partial<RetryPostRow> = {}): RetryPostRow => ({
    id: 'post-1',
    organizationId: 'org-1',
    state: 'ERROR',
    deletedAt: null,
    parentPostId: null,
    releaseId: null,
    releaseURL: null,
    error: 'No Post',
    ...patch,
    integration: {
      providerIdentifier: 'facebook',
      disabled: false,
      refreshNeeded: false,
      inBetweenSteps: false,
      deletedAt: null,
      ...patch.integration,
    },
  });
  const rejection = (p: RetryPostRow | null | undefined) => {
    const decision = retryDecision(p);
    expect(decision.ok).toBe(false);
    return decision.ok === false ? decision.rejection : undefined;
  };

  it('404 not_found for a missing post', () => {
    expect(rejection(null)).toEqual({ status: 404, code: 'not_found' });
    expect(rejection(undefined)).toEqual({ status: 404, code: 'not_found' });
  });

  it('409 deleted', () => {
    expect(rejection(post({ deletedAt: new Date() }))).toEqual({
      status: 409,
      code: 'deleted',
    });
  });

  it('409 not_first_post', () => {
    expect(rejection(post({ parentPostId: 'post-0' }))).toEqual({
      status: 409,
      code: 'not_first_post',
    });
  });

  it('409 already_queued', () => {
    expect(rejection(post({ state: 'QUEUE' }))).toEqual({
      status: 409,
      code: 'already_queued',
    });
  });

  it.each(['PUBLISHED', 'DRAFT'] as const)(
    '409 not_failed in state %s',
    (state) => {
      expect(rejection(post({ state }))).toEqual({
        status: 409,
        code: 'not_failed',
        state,
      });
    }
  );

  it('409 channel_inactive with the flag', () => {
    const integration = (patch: object) =>
      post({ integration: patch as RetryPostRow['integration'] });
    expect(rejection(integration({ deletedAt: new Date() }))).toMatchObject({
      code: 'channel_inactive',
      flag: 'deleted',
    });
    expect(rejection(integration({ disabled: true }))).toMatchObject({
      code: 'channel_inactive',
      flag: 'disabled',
    });
    expect(rejection(integration({ refreshNeeded: true }))).toMatchObject({
      code: 'channel_inactive',
      flag: 'refresh_needed',
    });
    expect(rejection(integration({ inBetweenSteps: true }))).toMatchObject({
      code: 'channel_inactive',
      flag: 'in_between_steps',
    });
    expect(rejection(integration({ disabled: true }))?.status).toBe(409);
  });

  it('checks in order: deleted before not_first_post before already_queued before state before channel', () => {
    const dead = { deletedAt: new Date() } as RetryPostRow['integration'];
    expect(
      rejection(
        post({ deletedAt: new Date(), parentPostId: 'x', state: 'QUEUE' })
      )?.code
    ).toBe('deleted');
    expect(
      rejection(post({ parentPostId: 'x', state: 'QUEUE', integration: dead }))
        ?.code
    ).toBe('not_first_post');
    expect(rejection(post({ state: 'QUEUE', integration: dead }))?.code).toBe(
      'already_queued'
    );
    expect(
      rejection(post({ state: 'PUBLISHED', integration: dead }))?.code
    ).toBe('not_failed');
    expect(rejection(post({ integration: dead, error: null }))?.code).toBe(
      'channel_inactive'
    );
  });

  // The confirmation is checked by the service, after the check for a
  // running workflow. The decision only hands over the reason.
  it('ok with the reason for an unclear outcome', () => {
    expect(retryDecision(post({ error: 'socket hang up' }))).toEqual({
      ok: true,
      unclear: 'unconfirmed',
    });
    expect(
      retryDecision(post({ releaseURL: 'https://example.com/p/1' }))
    ).toEqual({ ok: true, unclear: 'published' });
  });

  it('ok without unclear in the safe case', () => {
    const decision = retryDecision(post());
    expect(decision).toEqual({ ok: true, unclear: undefined });
    expect((decision as { unclear?: string }).unclear).toBeUndefined();
  });
});

describe('postTaskQueue', () => {
  it.each([
    ['facebook', 'facebook'],
    ['instagram-standalone', 'instagram'],
    ['LinkedIn-Page', 'linkedin'],
  ])('%s -> %s', (provider, queue) => {
    expect(postTaskQueue(provider)).toBe(queue);
  });
});

describe('parseActor', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['only spaces', '   '],
    ['an array', ['a', 'b']],
    ['a space inside', 'a b'],
    ['a field separator', 'x result=started'],
    ['an equals sign', 'x=y'],
    ['a line break', 'anna\nresult=forged'],
    ['a carriage return', 'anna\rx'],
    ['a tab', 'anna\tx'],
    ['a control character', 'anna\u0007'],
    ['DEL', 'anna\u007f'],
    ['a C1 control character', 'anna\u0085'],
    ['an umlaut', 'jürgen@example.com'],
    ['too long', 'a'.repeat(ACTOR_MAX_LENGTH + 1)],
  ])('%s gives undefined', (_name, value) => {
    expect(parseActor(value as string | string[] | undefined)).toBeUndefined();
  });

  it.each(['smm@ysocial.media', 'user:123', 'a.b+c@x-y.de'])(
    'accepts %s',
    (actor) => {
      expect(parseActor(actor)).toBe(actor);
    }
  );

  it('trims a valid value', () => {
    expect(parseActor('  anna@example.com  ')).toBe('anna@example.com');
  });

  it('accepts the maximum length, counted after trimming', () => {
    const actor = 'a'.repeat(ACTOR_MAX_LENGTH);
    expect(parseActor(actor)).toBe(actor);
    expect(parseActor(` ${actor} `)).toBe(actor);
  });
});
