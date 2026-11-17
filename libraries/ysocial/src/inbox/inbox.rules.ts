/**
 * Inbox demo for the Meta screencasts (PLAN 3.3 PR 26, E25, W15): read the
 * comments of the latest posts of a channel, reply as the account, hide and
 * delete. Pure functions and types, the platform calls are in
 * instagram.inbox.ts and facebook.inbox.ts (Graph API in meta.graph.ts).
 *
 * Only for the channels listed in YSOCIAL_DEMO_INTEGRATIONS (ids, comma
 * separated, only Y Social channels on staging). Without the variable the
 * routes do not exist (404, like the test switch). Every action is a call of
 * a person through the route (rule 2): no workflow, no schedule, no
 * automatic reply. Nothing is stored, no table: the hub stores and makes
 * tickets later (Phase 3).
 */

import { inboxEventsEnabled } from '../webhooks/webhook.rules';

export const YSOCIAL_DEMO_INTEGRATIONS_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
// Phase 3, PR 73: the inbox routes for every active Facebook and Instagram
// channel, not only the demo list. Only "true" switches it on (fail-closed).
export const YSOCIAL_INBOX_ENABLED_ENV = 'YSOCIAL_INBOX_ENABLED';

type Env = Record<string, string | undefined>;

export const demoIntegrationIds = (env: Env) =>
  (env[YSOCIAL_DEMO_INTEGRATIONS_ENV] || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

// The demo routes exist only with at least one listed channel.
export const inboxDemoEnabled = (env: Env) =>
  demoIntegrationIds(env).length > 0;

export const isDemoIntegration = (env: Env, integrationId: string) =>
  demoIntegrationIds(env).includes(integrationId);

export const inboxEnabled = (env: Env) =>
  env[YSOCIAL_INBOX_ENABLED_ENV] === 'true';

// The inbox routes exist with the demo list or with the switch.
export const inboxRoutesEnabled = (env: Env) =>
  inboxDemoEnabled(env) || inboxEnabled(env);

// The routes that put our app on the Page of a channel: with the demo list,
// or for every channel with YSOCIAL_INBOX_EVENTS=true (PR 74).
export const inboxWebhookRoutesEnabled = (env: Env) =>
  inboxDemoEnabled(env) || inboxEventsEnabled(env);

// Postiz channel ids are cuids. Only an id of this form goes into a query
// or the log.
export const isIntegrationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

// Ids of Meta objects go into the URL path of the Graph API and into the
// log, so only digits and "_" (Facebook ids are <page>_<post>). No "/" or
// "." that could point the call at another node.
const PLATFORM_ID_PATTERN = /^[0-9_]{1,64}$/;

export const isPlatformId = (value: unknown): value is string =>
  typeof value === 'string' && PLATFORM_ID_PATTERN.test(value);

// Latest posts per read and comments per post. Instagram returns at most 50
// comments per query, newest first. Facebook gets the same numbers.
export const INBOX_POSTS_LIMIT = 10;
export const INBOX_COMMENTS_LIMIT = 50;

// Upper bound for a reply, like maxLength() of the Postiz Instagram
// provider, for Facebook as well. The platform may reject shorter texts,
// then the route answers platform_error.
export const INBOX_REPLY_MAX_LENGTH = 2200;

export interface InboxReply {
  id: string;
  text: string;
  username: string | null;
  timestamp: string | null;
  likeCount: number;
  hidden: boolean;
  // Written by the Page or the account of the channel itself, also from
  // Business Suite or another tool. Only this flag leaves the fork, never
  // the id of the author.
  fromOwner: boolean;
  // Names the platform tagged in the text, never their ids (W76).
  mentions: string[];
}

// The hub redacts tagged names like the author before a text goes to the AI
// (W76): the name of a tag and the part of the text it covers. At most this
// many per entry, each cut to this length.
export const INBOX_MENTIONS_LIMIT = 50;
export const INBOX_MENTION_MAX_LENGTH = 300;

// The entries of mentions: strings only, trimmed and cut, without empty
// ones and doubles, in order.
// A cut never leaves half of a surrogate pair at the end.
export const mentionNames = (names: unknown[]): string[] =>
  [
    ...new Set(
      names
        .filter((name): name is string => typeof name === 'string')
        .map((name) =>
          name
            .trim()
            .slice(0, INBOX_MENTION_MAX_LENGTH)
            .replace(/[\uD800-\uDBFF]$/, '')
        )
        .filter(Boolean)
    ),
  ].slice(0, INBOX_MENTIONS_LIMIT);

export interface InboxComment extends InboxReply {
  replies: InboxReply[];
}

// No caption: post text is a decision of its own (read API, PR 18). The
// permalink links the comment to its post.
export interface InboxPost {
  id: string;
  permalink: string | null;
  timestamp: string | null;
  mediaType: string | null;
  commentsCount: number;
  comments: InboxComment[];
}

// What an inbox provider gets from the channel. The token stays in
// YsocialInboxService and the provider, it never reaches a log or a response.
export interface InboxChannel {
  internalId: string;
  token: string;
}

/**
 * Reading for the hub (Phase 3, PR 73, E82). The hub polls every 5 minutes
 * with since = its last read. Posts of the window: created in the last
 * INBOX_WINDOW_DAYS days, or with olderThan the posts before that time (the
 * hourly pass over older posts), with postsAfter not before that time. A
 * page of the platform starts only while the budget lasts, nextCursor
 * continues it with the same query.
 */
export const INBOX_WINDOW_DAYS = 30;
// Facebook reads its posts with their comments and replies in one call, a
// small page keeps that call light. Instagram reads INBOX_POSTS_LIMIT media
// per page.
export const INBOX_FACEBOOK_POSTS_PER_PAGE = 10;
// Replies per comment in one read. Facebook reads more of a thread again,
// newest first.
export const INBOX_REPLIES_LIMIT = 25;
// nginx in the Postiz image waits 60 s, the hub 35 s for a read and 65 s
// for a write (PLAN Phase 3, PR 77). The search for a comment before a
// write has the same budget, the write itself up to 15 s more.
export const INBOX_READ_BUDGET_MS = 25_000;

export interface InboxWindow {
  // Comments and replies with a time at or after since. null: all.
  since: Date | null;
  // Posts created at or after postsFrom and before postsBefore.
  postsFrom: Date | null;
  postsBefore: Date | null;
  // Cursor of the platform from nextCursor of the page before.
  cursor: string | null;
}

// One comment or reply, flat. parentId is the top-level comment of a reply,
// null for a top-level comment (one ticket per top-level comment, E83).
export interface InboxItem extends InboxReply {
  postId: string;
  parentId: string | null;
}

export interface InboxItemPost {
  id: string;
  permalink: string | null;
  timestamp: string | null;
  mediaType: string | null;
  // Instagram: comments_count of the platform, replies included. Facebook:
  // null, a Page post has no such field.
  commentsCount: number | null;
  // The platform has more comments or replies than this read returns.
  truncated: boolean;
}

export interface InboxItemsPage {
  posts: InboxItemPost[];
  items: InboxItem[];
  // null: the window is read to its end.
  nextCursor: string | null;
}

// What the platform allows per channel (E84, W69). realtime: webhooks
// (PR 74, after the App Review), until then false.
export interface InboxCapabilities {
  reply: boolean;
  hide: boolean;
  delete: boolean;
  like: boolean;
  realtime: boolean;
}

// Cursors of the Graph API: base64-like, no "&" or "/".
export const INBOX_CURSOR_PATTERN = /^[A-Za-z0-9_=-]{1,512}$/;

export const isInboxCursor = (value: unknown): value is string =>
  typeof value === 'string' && INBOX_CURSOR_PATTERN.test(value);

// Times in the query: ISO 8601 with date and time. IsISO8601 alone also lets
// week and ordinal dates through, which Date cannot read.
export const INBOX_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const DAY_MS = 24 * 60 * 60_000;

const dateOf = (value: string | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

export interface InboxItemsQuery {
  since?: string;
  olderThan?: string;
  postsAfter?: string;
  cursor?: string;
}

// The query of GET …/items, checked by YsocialInboxItemsQueryDto. Without
// olderThan the window is the posts of the last INBOX_WINDOW_DAYS days.
// With olderThan the posts before it, down to postsAfter if given.
export const inboxWindow = (query: InboxItemsQuery, now: Date): InboxWindow => {
  const postsBefore = dateOf(query.olderThan);
  return {
    since: dateOf(query.since),
    postsFrom: postsBefore
      ? dateOf(query.postsAfter)
      : new Date(now.getTime() - INBOX_WINDOW_DAYS * DAY_MS),
    postsBefore,
    cursor: isInboxCursor(query.cursor) ? query.cursor : null,
  };
};

/**
 * Load of the app at Meta from the header x-business-use-case-usage of each
 * Graph answer (E82): the highest percentage of call_count, total_cputime
 * and total_time, and estimated_time_to_regain_access in minutes. The hub
 * slows the channel down from 80 %. Numbers only, the business id stays out.
 */
export interface InboxUsage {
  percent: number;
  regainMinutes: number;
}

export class InboxUsageMeter {
  private _usage: InboxUsage | null = null;

  record(header: string | null | undefined) {
    if (!header || header.length > 10_000) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(header);
    } catch (err) {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    for (const entries of Object.values(parsed)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const percent = Math.max(
          0,
          ...['call_count', 'total_cputime', 'total_time'].map((key) =>
            finite(entry?.[key])
          )
        );
        const regainMinutes = finite(entry?.estimated_time_to_regain_access);
        this._usage = {
          percent: Math.max(this._usage?.percent ?? 0, percent),
          regainMinutes: Math.max(
            this._usage?.regainMinutes ?? 0,
            regainMinutes
          ),
        };
      }
    }
  }

  get usage(): InboxUsage | null {
    return this._usage;
  }
}

const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * One inbox provider per Postiz provider identifier (E25 variant B: own
 * provider files in libraries/ysocial/src/inbox/, with the tokens of the
 * Postiz channels, without a Postiz patch).
 */
export interface YsocialInboxProvider {
  identifier: string;
  capabilities: InboxCapabilities;
  listComments(channel: InboxChannel): Promise<InboxPost[]>;
  // Comments and replies of the posts in the window (PR 73).
  listItems(
    channel: InboxChannel,
    window: InboxWindow,
    usage: InboxUsageMeter
  ): Promise<InboxItemsPage>;
  // The conversation of a comment of this channel: its top-level comment
  // and the replies. null: not a comment on a post of this channel.
  // postId: the post of the comment as the hub knows it from items. Only a
  // hint, the provider checks it. Throws InboxOwnershipUnknownError when
  // the search runs out of time.
  getConversation(
    channel: InboxChannel,
    commentId: string,
    usage: InboxUsageMeter,
    postId?: string | null
  ): Promise<{ post: InboxItemPost | null; items: InboxItem[] } | null>;
  // Only where capabilities.like is true; the service checks before.
  like(channel: InboxChannel, commentId: string, like: boolean): Promise<void>;
  // true only if the comment is on a post of this channel. postId and the
  // error as for getConversation.
  ownsComment(
    channel: InboxChannel,
    commentId: string,
    postId?: string | null
  ): Promise<boolean>;
  // id of the new reply, null if the platform did not return one.
  reply(
    channel: InboxChannel,
    commentId: string,
    message: string
  ): Promise<{ id: string | null }>;
  hide(channel: InboxChannel, commentId: string, hide: boolean): Promise<void>;
  remove(channel: InboxChannel, commentId: string): Promise<void>;
  // Webhooks of the demo (PR B): our app on the Page of the channel and
  // the Page fields it receives.
  webhookSubscription(
    channel: InboxChannel
  ): Promise<{ subscribed: boolean; fields: string[] }>;
  subscribeWebhooks(channel: InboxChannel): Promise<{ fields: string[] }>;
}

/**
 * The platform refused a call or could not be reached. Only codes and a
 * sanitized reason, never the token, the URL or a comment text.
 * message carries the codes only, so a log of err.message stays clean.
 * unreadable: a 2xx without a JSON object as body (meta.graph.ts).
 */
export class InboxPlatformError extends Error {
  constructor(
    readonly details: {
      unavailable: boolean;
      unreadable?: boolean;
      status?: number;
      code?: number;
      subcode?: number;
      reason?: string;
    }
  ) {
    super(
      details.unavailable
        ? 'platform unavailable'
        : `platform error status=${details.status ?? '-'} code=${
            details.code ?? '-'
          }/${details.subcode ?? '-'}${details.unreadable ? ' unreadable' : ''}`
    );
    this.name = 'InboxPlatformError';
  }
}

// The search for a comment ran out of INBOX_READ_BUDGET_MS before it found
// the comment or reached the end. Whether it belongs to the channel is
// unknown, so no write (503 ownership_unknown).
export class InboxOwnershipUnknownError extends Error {
  constructor() {
    super('ownership unknown');
    this.name = 'InboxOwnershipUnknownError';
  }
}
