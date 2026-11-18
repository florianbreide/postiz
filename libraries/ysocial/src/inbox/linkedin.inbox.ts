import { sanitizeReason } from '../events/hub.event';
import {
  INBOX_READ_BUDGET_MS,
  InboxCapabilities,
  InboxChannel,
  InboxItem,
  InboxItemPost,
  InboxItemsPage,
  InboxOwnershipUnknownError,
  InboxPlatformError,
  InboxPost,
  InboxReply,
  InboxUsageMeter,
  InboxWindow,
  mentionNames,
  taggedPart,
  YsocialInboxProvider,
} from './inbox.rules';
import {
  beforePostWindow,
  count,
  GraphObject,
  inPostWindow,
  newSince,
} from './meta.graph';

/**
 * Inbox for the Postiz provider "linkedin-page" (LinkedIn page, Community
 * Management API, Phase 3 PR 75, E92). Read comments under posts of the
 * page, reply as the page, delete, like. No hide: the Comments API has none
 * (W28, Hub docs/plattformen/linkedin.md 3).
 *
 * Endpoints and permissions, Microsoft Learn (read 18.11.2026):
 * - GET /rest/posts?q=author&author={org}&sortBy=CREATED (X-RestLi-Method
 *   FINDER): posts of the page, newest first by creation ("descending
 *   order"), count at most 100, paging with start. r_organization_social.
 *   GET /rest/posts/{urn}: one post with author and lifecycleState.
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * - GET /rest/socialActions/{share|ugcPost|comment urn}/comments: the
 *   comments of a post, or the replies of a comment ("provide a parent
 *   commentUrn as the target"). /comments/{id}: one comment. A reply: POST
 *   /rest/socialActions/{comment urn}/comments with actor, object (the post)
 *   and parentComment ("Create a Comment on a Comment"), its id in the
 *   header x-restli-id. DELETE /rest/socialActions/{share|ugcPost}/comments
 *   /{id}?actor={org}: delete as the page, a reply as well (the doc shows
 *   only this path). Reading needs r_organization_social_feed and the page
 *   role ADMINISTRATOR or DIRECT_SPONSORED_CONTENT_POSTER, writing
 *   w_organization_social_feed. count and start on the comments and the
 *   paging of the answer are not on the page: ungeprüft (README).
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
 * - POST /rest/reactions?actor={org} with root and reactionType LIKE (201),
 *   DELETE /rest/reactions/(actor:{org},entity:{comment urn}) (204). The
 *   page names both a comment and the post as root of a reaction on a
 *   comment; the comment is used (ungeprüft).
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api
 * - "URNs included in the URL params must be URL encoded" (Posts API), with
 *   ( ) and , as in the example of the Reactions API (encodeUrn).
 *
 * Scopes: r_organization_social from Postiz, r_organization_social_feed and
 * w_organization_social_feed since ysocial patch 7 (scopes/linkedin.scopes.ts).
 * Token: Integration.token of "linkedin-page" is the access token of the
 * member who connected the page. internalId is the organization id.
 *
 * Calls: Development Tier allows 100 calls per member and 500 per app a day,
 * Postiz posts with the same app (linkedin.md 1.3). So the inbox needs
 * YSOCIAL_INBOX_LINKEDIN=true, and one read makes at most
 * LINKEDIN_CALLS_PER_READ calls, started within LINKEDIN_START_BUDGET_MS.
 *
 * Ids: the routes take digits and "_" only (isPlatformId), so the URNs are
 * written as numbers, the kind first (URN_KINDS):
 * - post <kind>_<id> for urn:li:<share|ugcPost>:<id>,
 * - comment <kind>_<thread>_<id> for urn:li:comment:(urn:li:<kind>:<thread>,<id>),
 * - reply <kind>_<thread>_<parent>_<id>, the parent its top-level comment.
 *
 * comment_not_found (the hub marks the comment deleted, for good) only when
 * LinkedIn says 404 or an answer names another post, owner or thread. An
 * answer without the fields to tell is unreadable (502), never "not found".
 */

export const YSOCIAL_INBOX_LINKEDIN_ENV = 'YSOCIAL_INBOX_LINKEDIN';

// Our own version, not the 202601 of Postiz that ends on 15.01.2027 (R20).
// 202611 is active until 16.11.2027 (Microsoft Learn, Migrations).
export const LINKEDIN_INBOX_API_VERSION = '202611';

const LINKEDIN_API = 'https://api.linkedin.com/rest';
const LINKEDIN_TIMEOUT_MS = 15_000;

// One read: posts per page, comments per post and replies per comment, and
// at most this many calls (posts, comments, replies together).
export const LINKEDIN_POSTS_PER_PAGE = 5;
export const LINKEDIN_COMMENTS_LIMIT = 50;
export const LINKEDIN_REPLIES_LIMIT = 25;
export const LINKEDIN_CALLS_PER_READ = 20;
// The hub waits 35 s for a read (INBOX_READ_BUDGET_MS and 10 s more). A
// call starts only while it can end within that, at 15 s per call.
export const LINKEDIN_START_BUDGET_MS =
  INBOX_READ_BUDGET_MS + 10_000 - LINKEDIN_TIMEOUT_MS;

const URN_KINDS = ['activity', 'share', 'ugcPost'];
// A LinkedIn id without leading zeros, so each URN has exactly one id here.
const N = '(0|[1-9]\\d{0,19})';
const POST_ID = new RegExp(`^([12])_${N}$`);
const COMMENT_ID = new RegExp(`^([012])_${N}_${N}(?:_${N})?$`);
const POST_URN = new RegExp(`^urn:li:(share|ugcPost):${N}$`);
// The Reactions API also writes urn:li:comment:(activity:…,…).
const COMMENT_URN = new RegExp(
  `^urn:li:comment:\\((?:urn:li:)?(activity|share|ugcPost):${N},${N}\\)$`
);
const ORG_ID = /^\d{1,20}$/;

interface CommentRef {
  kind: number;
  thread: string;
  // The top-level comment of a reply, null for a top-level comment.
  parent: string | null;
  id: string;
}

// The calls of one route and when its time is up.
interface Budget {
  made: number;
  until: number;
}

const commentUrnOf = (kind: number, thread: string, id: string) =>
  `urn:li:comment:(urn:li:${URN_KINDS[kind]}:${thread},${id})`;

// A URN in the path: encodeURIComponent leaves ( and ) as they are.
const encodeUrn = (urn: string) =>
  encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29');

const idOfComment = (ref: CommentRef) =>
  [ref.kind, ref.thread, ...(ref.parent ? [ref.parent] : []), ref.id].join('_');

const parseCommentId = (value: string): CommentRef | null => {
  const match = COMMENT_ID.exec(value);
  if (!match) {
    return null;
  }
  return match[4]
    ? { kind: +match[1], thread: match[2], parent: match[3], id: match[4] }
    : { kind: +match[1], thread: match[2], parent: null, id: match[3] };
};

const idOfPost = (urn: unknown) => {
  const match = POST_URN.exec(String(urn ?? ''));
  return match ? `${URN_KINDS.indexOf(match[1])}_${match[2]}` : null;
};

const postUrnOf = (postId: string) => {
  const match = POST_ID.exec(postId);
  return match ? `urn:li:${URN_KINDS[+match[1]]}:${match[2]}` : null;
};

// The post of a comment, from its own id when its thread is a share or a
// ugcPost, otherwise from the hint. null: none, or the two disagree.
const postOf = (ref: CommentRef, hint?: string | null) => {
  const own = ref.kind ? `${ref.kind}_${ref.thread}` : null;
  if (own && hint && hint !== own) {
    return null;
  }
  const postId = own ?? hint ?? null;
  return postId && postUrnOf(postId) ? postId : null;
};

// The comment URN of an answer as a ref, null without one.
const refOf = (row: GraphObject, parent: string | null): CommentRef | null => {
  const match = COMMENT_URN.exec(String(row?.commentUrn ?? ''));
  return match
    ? {
        kind: URN_KINDS.indexOf(match[1]),
        thread: match[2],
        parent,
        id: match[3],
      }
    : null;
};

const sameThread = (a: CommentRef, b: CommentRef) =>
  a.kind === b.kind && a.thread === b.thread;

const isoOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;

const elements = (body: GraphObject | null): GraphObject[] =>
  Array.isArray(body?.elements) ? body!.elements : [];

// More than this answer: a link "next", or a total above what came.
const hasNext = (body: GraphObject | null) => {
  const paging = body?.paging;
  return (
    (Array.isArray(paging?.links) &&
      paging.links.some((link: GraphObject) => link?.rel === 'next')) ||
    (typeof paging?.total === 'number' &&
      count(paging.start) + elements(body).length < paging.total)
  );
};

// No name: the name of a member needs the Profile API, which the
// Community Management app does not have (ungeprüft, README). fromOwner:
// written as the page, actor is the organization. mentions: the parts of
// the text LinkedIn marks as a person or an organization, never the URN.
const toReply = (
  row: GraphObject,
  ref: CommentRef,
  org: string
): InboxReply => {
  const message = typeof row.message?.text === 'string' ? row.message.text : '';
  const attributes = Array.isArray(row.message?.attributes)
    ? row.message.attributes
    : [];
  return {
    id: idOfComment(ref),
    text: message,
    username: null,
    timestamp: isoOf(row.created?.time),
    likeCount: count(row.likesSummary?.totalLikes),
    hidden: false,
    fromOwner: row.actor === org,
    mentions: mentionNames(
      attributes
        .filter(
          (attribute: GraphObject) =>
            !!(attribute?.value?.person || attribute?.value?.organization)
        )
        .map((attribute: GraphObject) =>
          taggedPart(message, attribute.start, attribute.length)
        )
    ),
  };
};

// Replies: when the comment counts some, or when it does not say (the
// field is only in one example of the doc).
const mayHaveReplies = (row: GraphObject) => {
  const summary = row?.commentsSummary;
  const total =
    summary?.totalFirstLevelComments ?? summary?.aggregatedTotalComments;
  return typeof total !== 'number' || total > 0;
};

const permalinkOf = (urn: string) =>
  `https://www.linkedin.com/feed/update/${urn}/`;

const toItemPost = (row: GraphObject, truncated: boolean): InboxItemPost => ({
  id: idOfPost(row.id)!,
  permalink: permalinkOf(row.id),
  timestamp: isoOf(row.createdAt),
  mediaType: null,
  commentsCount: null,
  truncated,
});

const unreadableAnswer = (status = 200) =>
  new InboxPlatformError({
    unavailable: false,
    unreadable: true,
    status,
    reason: 'Die Plattform hat keine lesbare Antwort geschickt.',
  });

// A read must answer with a JSON object.
const readable = (answer: GraphObject | null) => {
  if (!answer) {
    throw unreadableAnswer();
  }
  return answer;
};

// LinkedIn names URNs in its errors, the one of a member must not leave the
// fork.
const linkedinReason = (message: unknown) =>
  typeof message === 'string'
    ? sanitizeReason(
        message.replace(/urn:li:(person|member):[^\s,)"']+/g, 'urn:li:$1:***')
      )
    : undefined;

/**
 * One call to the LinkedIn REST API. The token goes in the header only,
 * never into a log or an error. answer: the JSON body, null for an empty
 * one (201, 204). id: the header x-restli-id of a created entity.
 */
export const linkedinApi = async (
  method: 'GET' | 'POST' | 'DELETE',
  accessToken: string,
  path: string,
  query: Record<string, string> = {},
  options: { body?: GraphObject; finder?: boolean } = {}
): Promise<{ answer: GraphObject | null; id: string | null }> => {
  const search = new URLSearchParams(query).toString();
  let res: Response;
  try {
    res = await fetch(`${LINKEDIN_API}/${path}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': LINKEDIN_INBOX_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
        ...(options.finder ? { 'X-RestLi-Method': 'FINDER' } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(LINKEDIN_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout. The cause is not passed on.
    throw new InboxPlatformError({ unavailable: true });
  }

  let timedOut = false;
  const parsed: unknown = await res.json().catch((err) => {
    timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return undefined;
  });
  const answer =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as GraphObject)
      : null;
  if (!res.ok) {
    throw new InboxPlatformError({
      unavailable: false,
      status: res.status,
      code:
        typeof answer?.serviceErrorCode === 'number'
          ? answer.serviceErrorCode
          : undefined,
      reason: linkedinReason(answer?.message),
    });
  }
  if (timedOut) {
    throw new InboxPlatformError({ unavailable: true });
  }
  const id = res.headers?.get?.('x-restli-id');
  return { answer, id: id && /^\d{1,20}$/.test(id) ? id : null };
};

// 404: the post or comment is not there (any more) for this token.
const isNotFound = (err: unknown) =>
  err instanceof InboxPlatformError && err.details.status === 404;

export class LinkedinInbox implements YsocialInboxProvider {
  identifier = 'linkedin-page';
  capabilities: InboxCapabilities = {
    reply: true,
    hide: false,
    delete: true,
    like: true,
    realtime: false,
  };
  // Wall clock for the read budget, set in tests.
  protected clock = () => Date.now();

  enabled(env: NodeJS.ProcessEnv) {
    return env[YSOCIAL_INBOX_LINKEDIN_ENV] === 'true';
  }

  // The demo: the latest posts with their comments and replies.
  async listComments(channel: InboxChannel): Promise<InboxPost[]> {
    const org = this.orgUrn(channel);
    const budget = this.budget();
    const page = await this.postsPage(channel, org, 0, budget);
    const posts: InboxPost[] = [];
    for (const row of elements(page).filter((row) =>
      this.isOwnPost(row, org)
    )) {
      if (this.spent(budget)) {
        break;
      }
      const { comments } = await this.readThreads(channel, row.id, org, budget);
      posts.push({
        id: idOfPost(row.id)!,
        permalink: permalinkOf(row.id),
        timestamp: isoOf(row.createdAt),
        mediaType: null,
        commentsCount: comments.length,
        comments: comments.map(({ top, replies }) => ({ ...top, replies })),
      });
    }
    return posts;
  }

  /**
   * Comments and replies of the posts in the window. The posts come newest
   * first by creation, so the first one older than the window ends it. The
   * cursor is the index of the next post. A read stops before a post when
   * the calls or the time of the budget are used up, never before its first
   * post, so the cursor always moves on.
   */
  async listItems(
    channel: InboxChannel,
    window: InboxWindow
  ): Promise<InboxItemsPage> {
    const org = this.orgUrn(channel);
    const budget = this.budget();
    const posts: InboxItemPost[] = [];
    const items: InboxItem[] = [];
    let start =
      window.cursor && /^\d{1,6}$/.test(window.cursor) ? +window.cursor : 0;
    // The first post of a read always runs, so the cursor moves on.
    const first = start;

    for (;;) {
      const page = await this.postsPage(channel, org, start, budget);
      const rows = elements(page);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (beforePostWindow(isoOf(row?.createdAt), window)) {
          return { posts, items, nextCursor: null };
        }
        if (
          !this.isOwnPost(row, org) ||
          !inPostWindow(isoOf(row.createdAt), window)
        ) {
          continue;
        }
        if (start + index > first && this.spent(budget)) {
          return { posts, items, nextCursor: String(start + index) };
        }
        const postId = idOfPost(row.id)!;
        const { comments, truncated } = await this.readThreads(
          channel,
          row.id,
          org,
          budget
        );
        posts.push(toItemPost(row, truncated));
        for (const { top, replies } of comments) {
          items.push(
            ...[
              { ...top, postId, parentId: null },
              ...replies.map((reply) => ({
                ...reply,
                postId,
                parentId: top.id,
              })),
            ].filter((item) => newSince(item.timestamp, window.since))
          );
        }
      }
      if (rows.length < LINKEDIN_POSTS_PER_PAGE) {
        return { posts, items, nextCursor: null };
      }
      start += rows.length;
      if (this.spent(budget)) {
        return { posts, items, nextCursor: String(start) };
      }
    }
  }

  /**
   * The thread of a comment of this page: the post must be a post of the
   * organization, the comment under it, a reply under its top-level comment.
   * Without a post (a comment on an activity thread, no hint, or a hint that
   * contradicts the id) the owner stays unknown: no search over the posts,
   * it would cost calls of the day (InboxOwnershipUnknownError, 503
   * ownership_unknown).
   */
  async getConversation(
    channel: InboxChannel,
    commentId: string,
    _usage: InboxUsageMeter,
    postId?: string | null
  ) {
    const org = this.orgUrn(channel);
    const located = await this.locate(channel, commentId, postId, org);
    if (!located) {
      return null;
    }
    const { post, ref, top, topRef, reply } = located;
    const { replies, truncated } = await this.readReplies(
      channel,
      topRef,
      org,
      this.budget()
    );
    const itemPostId = idOfPost(post.id)!;
    const topItem = toReply(top, topRef, org);
    const items: InboxItem[] = [
      { ...topItem, postId: itemPostId, parentId: null },
      ...replies.map((item) => ({
        ...item,
        postId: itemPostId,
        parentId: topItem.id,
      })),
    ];
    if (reply && !items.some((item) => item.id === commentId)) {
      // A reply beyond the first page of replies.
      items.push({
        ...toReply(reply, ref, org),
        postId: itemPostId,
        parentId: topItem.id,
      });
    }
    return { post: toItemPost(post, truncated), items };
  }

  async ownsComment(
    channel: InboxChannel,
    commentId: string,
    postId?: string | null
  ) {
    return !!(await this.locate(
      channel,
      commentId,
      postId,
      this.orgUrn(channel)
    ));
  }

  // Always to the top-level comment of the thread, as the page, through the
  // comment ("Create a Comment on a Comment").
  async reply(
    channel: InboxChannel,
    commentId: string,
    message: string,
    postId?: string | null
  ) {
    const { ref, postUrn } = this.target(commentId, postId);
    const parent = ref.parent ?? ref.id;
    const parentUrn = commentUrnOf(ref.kind, ref.thread, parent);
    const { id } = await this.api(
      'POST',
      channel,
      `socialActions/${encodeUrn(parentUrn)}/comments`,
      {},
      {
        body: {
          actor: this.orgUrn(channel),
          object: postUrn,
          message: { text: message },
          parentComment: parentUrn,
        },
      }
    );
    return {
      id: id
        ? idOfComment({ kind: ref.kind, thread: ref.thread, parent, id })
        : null,
    };
  }

  async hide(): Promise<void> {
    // capabilities.hide is false, the service never gets here.
    throw new InboxPlatformError({
      unavailable: false,
      reason: 'LinkedIn kann Kommentare nicht verbergen.',
    });
  }

  // As the page, under the post, a reply as well (README, ungeprüft).
  async remove(
    channel: InboxChannel,
    commentId: string,
    postId?: string | null
  ) {
    const { ref, postUrn } = this.target(commentId, postId);
    await this.api(
      'DELETE',
      channel,
      `socialActions/${encodeUrn(postUrn)}/comments/${ref.id}`,
      { actor: this.orgUrn(channel) }
    );
  }

  // LIKE as the page. A like that is there already, or an unlike of none,
  // counts as done (ungeprüft, README).
  async like(
    channel: InboxChannel,
    commentId: string,
    like: boolean,
    postId?: string | null
  ) {
    const { ref } = this.target(commentId, postId);
    const org = this.orgUrn(channel);
    const comment = commentUrnOf(ref.kind, ref.thread, ref.id);
    try {
      if (like) {
        await this.api(
          'POST',
          channel,
          'reactions',
          { actor: org },
          { body: { root: comment, reactionType: 'LIKE' } }
        );
      } else {
        await this.api(
          'DELETE',
          channel,
          `reactions/(actor:${encodeUrn(org)},entity:${encodeUrn(comment)})`
        );
      }
    } catch (err) {
      const status = (err as InboxPlatformError)?.details?.status;
      if (
        err instanceof InboxPlatformError &&
        ((like && status === 409) || (!like && status === 404))
      ) {
        return;
      }
      throw err;
    }
  }

  // No webhooks for LinkedIn in the Development Tier (linkedin.md 1.3).
  async webhookSubscription() {
    return { subscribed: false, fields: [] as string[] };
  }

  async subscribeWebhooks(): Promise<{ fields: string[] }> {
    throw new InboxPlatformError({
      unavailable: false,
      reason: 'LinkedIn hat für diese Seite keine Webhooks.',
    });
  }

  private budget(): Budget {
    return { made: 0, until: this.clock() + LINKEDIN_START_BUDGET_MS };
  }

  private spent(budget: Budget) {
    return (
      budget.made >= LINKEDIN_CALLS_PER_READ || this.clock() > budget.until
    );
  }

  // The post and the comment of a write, from the id and the hint. The
  // service ran ownsComment with the same values before.
  private target(commentId: string, postId?: string | null) {
    const ref = parseCommentId(commentId);
    const post = ref ? postOf(ref, postId) : null;
    if (!ref || !post) {
      throw new InboxOwnershipUnknownError();
    }
    return { ref, postUrn: postUrnOf(post)! };
  }

  // null: not a comment of this page. No post to check: ownership unknown.
  private async locate(
    channel: InboxChannel,
    commentId: string,
    hint: string | null | undefined,
    org: string
  ): Promise<{
    post: GraphObject;
    ref: CommentRef;
    top: GraphObject;
    topRef: CommentRef;
    reply: GraphObject | null;
  } | null> {
    const ref = parseCommentId(commentId);
    if (!ref) {
      return null;
    }
    const postId = postOf(ref, hint);
    if (!postId) {
      throw new InboxOwnershipUnknownError();
    }
    const postUrn = postUrnOf(postId)!;
    const topId = ref.parent ?? ref.id;
    const budget = this.budget();
    try {
      const post = await this.read(
        channel,
        `posts/${encodeUrn(postUrn)}`,
        budget
      );
      if (typeof post.id !== 'string' || typeof post.author !== 'string') {
        throw unreadableAnswer();
      }
      if (post.id !== postUrn || post.author !== org) {
        return null;
      }

      const top = await this.read(
        channel,
        `socialActions/${encodeUrn(postUrn)}/comments/${topId}`,
        budget
      );
      const topRef = refOf(top, null);
      if (!topRef) {
        throw unreadableAnswer();
      }
      if (
        topRef.id !== topId ||
        top.parentComment ||
        !sameThread(topRef, ref)
      ) {
        return null;
      }
      if (!ref.parent) {
        return { post, ref, top, topRef, reply: null };
      }

      const reply = await this.read(
        channel,
        `socialActions/${encodeUrn(
          commentUrnOf(ref.kind, ref.thread, ref.parent)
        )}/comments/${ref.id}`,
        budget
      );
      const replyRef = refOf(reply, ref.parent);
      if (!replyRef) {
        throw unreadableAnswer();
      }
      return replyRef.id === ref.id && sameThread(replyRef, ref)
        ? { post, ref, top, topRef, reply }
        : null;
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  private postsPage(
    channel: InboxChannel,
    org: string,
    start: number,
    budget: Budget
  ) {
    return this.read(channel, 'posts', budget, {
      query: {
        q: 'author',
        author: org,
        sortBy: 'CREATED',
        count: String(LINKEDIN_POSTS_PER_PAGE),
        start: String(start),
      },
      finder: true,
    });
  }

  // A published post of this organization, with a post URN.
  private isOwnPost(row: GraphObject, org: string) {
    return (
      !!idOfPost(row?.id) &&
      row.author === org &&
      row.lifecycleState === 'PUBLISHED'
    );
  }

  // The top-level comments of a post, each with its first page of replies.
  // truncated: the platform has more comments or replies than read.
  private async readThreads(
    channel: InboxChannel,
    postUrn: string,
    org: string,
    budget: Budget
  ) {
    const answer = await this.read(
      channel,
      `socialActions/${encodeUrn(postUrn)}/comments`,
      budget,
      { query: { count: String(LINKEDIN_COMMENTS_LIMIT) } }
    );
    let truncated = hasNext(answer);
    const comments: { top: InboxReply; replies: InboxReply[] }[] = [];
    for (const row of elements(answer)) {
      const ref = refOf(row, null);
      if (!ref || row.parentComment) {
        continue;
      }
      let replies: InboxReply[] = [];
      if (mayHaveReplies(row)) {
        if (this.spent(budget)) {
          truncated = true;
        } else {
          const read = await this.readReplies(channel, ref, org, budget);
          replies = read.replies;
          truncated = truncated || read.truncated;
        }
      }
      comments.push({ top: toReply(row, ref, org), replies });
    }
    return { comments, truncated };
  }

  // A reply of another thread does not count.
  private async readReplies(
    channel: InboxChannel,
    top: CommentRef,
    org: string,
    budget: Budget
  ) {
    const answer = await this.read(
      channel,
      `socialActions/${encodeUrn(
        commentUrnOf(top.kind, top.thread, top.id)
      )}/comments`,
      budget,
      { query: { count: String(LINKEDIN_REPLIES_LIMIT) } }
    );
    const replies = elements(answer).flatMap((row) => {
      const ref = refOf(row, top.id);
      return ref && sameThread(ref, top) ? [toReply(row, ref, org)] : [];
    });
    return { replies, truncated: hasNext(answer) };
  }

  private orgUrn(channel: InboxChannel) {
    if (!ORG_ID.test(channel.internalId)) {
      throw new Error('ysocial inbox: invalid platform id');
    }
    return `urn:li:organization:${channel.internalId}`;
  }

  // A GET that must answer with a JSON object, counted in the budget.
  private async read(
    channel: InboxChannel,
    path: string,
    budget: Budget,
    options: { query?: Record<string, string>; finder?: boolean } = {}
  ) {
    budget.made++;
    const { answer } = await this.api('GET', channel, path, options.query, {
      finder: options.finder,
    });
    return readable(answer);
  }

  private api(
    method: 'GET' | 'POST' | 'DELETE',
    channel: InboxChannel,
    path: string,
    query: Record<string, string> = {},
    options: { body?: GraphObject; finder?: boolean } = {}
  ) {
    return linkedinApi(method, channel.token, path, query, options);
  }
}
