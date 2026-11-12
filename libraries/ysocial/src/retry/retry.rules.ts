import { channelFlag, ChannelFlag, ChannelRow } from '../health/channel.health';
import { PostState } from '../verification/post.verification';

/**
 * When "Erneut versuchen" may start the Postiz post workflow again
 * (PLAN 3.3 PR 19). Pure functions.
 *
 * - Only the first post of a thread, in ERROR and not deleted. Postiz sets
 *   ERROR on the first post, and postWorkflowV112 would send a comment as a
 *   post of its own.
 * - The channel is active like in the missing-posts sweep of Postiz
 *   (posts.repository.ts, searchForMissingThreeHoursPosts): not deleted,
 *   disabled, refreshNeeded or inBetweenSteps.
 * - Unclear outcome: Postiz has no field for it. markUnconfirmed in
 *   post.workflow.v1.1.2.ts sets ERROR with the raw error. So the outcome
 *   counts as unclear unless the error proves that nothing went out
 *   (fail-closed, decision for PR 19). Then the route needs an explicit
 *   confirmation. The table is in apps/orchestrator/src/ysocial/README.md.
 */

export interface RetryPostRow {
  id: string;
  organizationId: string;
  state: PostState;
  deletedAt: Date | null;
  parentPostId: string | null;
  releaseId: string | null;
  releaseURL: string | null;
  error: string | null;
  integration: {
    providerIdentifier: string;
    disabled: boolean;
    refreshNeeded: boolean;
    inBetweenSteps: boolean;
    deletedAt: Date | null;
  };
}

// published: at least the first post is online (releaseId or releaseURL set,
// or a comment failed).
// unconfirmed: the error does not prove that nothing went out.
export type UnclearOutcome = 'published' | 'unconfirmed';

export type RetryRejection =
  | { status: 404; code: 'not_found' }
  | { status: 409; code: 'deleted' }
  | { status: 409; code: 'not_first_post' }
  | { status: 409; code: 'already_queued' }
  | { status: 409; code: 'not_failed'; state: PostState }
  | { status: 409; code: 'channel_inactive'; flag: ChannelFlag | 'deleted' };

export type RetryDecision =
  | { ok: true; unclear?: UnclearOutcome }
  | { ok: false; rejection: RetryRejection };

// Texts of post.workflow.v1.1.2.ts that are written before any publish call:
// no post, channel needs a refresh, channel disabled.
const NOTHING_SENT_ERRORS = new Set([
  'No Post',
  'Refresh channel needed',
  'Channel disabled',
]);

// The activities that publish the first post. A failed token refresh there
// ("stop") means the platform did not take the post, Postiz itself publishes
// again after a successful refresh. During the status check of a pending
// post (checkPostStatus, finalizePost) it means unconfirmed.
// bad_body proves nothing: SocialAbstract.fetch and runInConcurrent turn
// 500, 429 and network errors into BadBody, and providers use it for
// "may have already published" (facebook stories).
const FIRST_PUBLISH_ACTIVITIES = new Set(['postSocialPending', 'postSocial']);

// Temporal failures arrive as JSON, for example
// {"cause":{"type":"bad_body",…},"activityType":"postSocialPending",…}.
const parseFailure = (error: string) => {
  try {
    const value = JSON.parse(error);
    return value && typeof value === 'object'
      ? (value as { activityType?: unknown; cause?: { type?: unknown } })
      : undefined;
  } catch (err) {
    return undefined;
  }
};

export const unclearOutcome = (
  post: Pick<RetryPostRow, 'releaseId' | 'releaseURL' | 'error'>
): UnclearOutcome | undefined => {
  // updatePost and PublishedWithError store releaseId and releaseURL.
  if (post.releaseId || post.releaseURL) {
    return 'published';
  }

  const error = (post.error || '').trim();
  if (NOTHING_SENT_ERRORS.has(error)) {
    return undefined;
  }

  const failure = parseFailure(error);
  // Comments run only after the first post went out.
  if (failure?.activityType === 'postComment') {
    return 'published';
  }
  if (
    failure?.cause?.type === 'refresh_token' &&
    FIRST_PUBLISH_ACTIVITIES.has(String(failure.activityType))
  ) {
    return undefined;
  }

  return 'unconfirmed';
};

const reject = (rejection: RetryRejection): RetryDecision => ({
  ok: false,
  rejection,
});

// Post and channel only. The confirmation of an unclear outcome comes last,
// after the check for a running workflow (ysocial.retry.service.ts): nobody
// should confirm "not online" while Postiz may still be publishing.
export const retryDecision = (
  post: RetryPostRow | null | undefined
): RetryDecision => {
  if (!post) {
    return reject({ status: 404, code: 'not_found' });
  }
  if (post.deletedAt) {
    return reject({ status: 409, code: 'deleted' });
  }
  if (post.parentPostId) {
    return reject({ status: 409, code: 'not_first_post' });
  }
  if (post.state === 'QUEUE') {
    return reject({ status: 409, code: 'already_queued' });
  }
  if (post.state !== 'ERROR') {
    return reject({ status: 409, code: 'not_failed', state: post.state });
  }

  const flag = post.integration.deletedAt
    ? 'deleted'
    : channelFlag(post.integration as unknown as ChannelRow);
  if (flag) {
    return reject({ status: 409, code: 'channel_inactive', flag });
  }

  return { ok: true, unclear: unclearOutcome(post) };
};

// Same task queue as PostsService.changePostStatus and changeDate.
export const postTaskQueue = (providerIdentifier: string) =>
  providerIdentifier.split('-')[0].toLowerCase();

export const YSOCIAL_ACTOR_HEADER = 'x-ysocial-actor';
export const ACTOR_MAX_LENGTH = 200;

// The person in the hub who clicked "Erneut versuchen", an e-mail address or
// an id. Goes into the log, so only these characters: no spaces, no "=",
// no control characters (no forged log lines or fields).
const ACTOR_PATTERN = /^[\w.@+:-]+$/;

export const parseActor = (value?: string | string[]) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const actor = value.trim();
  if (actor.length > ACTOR_MAX_LENGTH || !ACTOR_PATTERN.test(actor)) {
    return undefined;
  }
  return actor;
};
