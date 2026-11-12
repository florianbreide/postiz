/**
 * Inbox demo for the Meta screencasts (PLAN 3.3 PR 26, E25, W15): read the
 * comments of the latest posts of a channel, reply as the account, hide and
 * delete. Pure functions and types, the platform calls are in
 * instagram.inbox.ts.
 *
 * Only for the channels listed in YSOCIAL_DEMO_INTEGRATIONS (ids, comma
 * separated, only Y Social channels on staging). Without the variable the
 * routes do not exist (404, like the test switch). Every action is a call of
 * a person through the route (rule 2): no workflow, no schedule, no
 * automatic reply. Nothing is stored, no table: the hub stores and makes
 * tickets later (Phase 3).
 */

export const YSOCIAL_DEMO_INTEGRATIONS_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';

type Env = Record<string, string | undefined>;

export const demoIntegrationIds = (env: Env) =>
  (env[YSOCIAL_DEMO_INTEGRATIONS_ENV] || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

// The routes exist only with at least one listed channel.
export const inboxDemoEnabled = (env: Env) =>
  demoIntegrationIds(env).length > 0;

export const isDemoIntegration = (env: Env, integrationId: string) =>
  demoIntegrationIds(env).includes(integrationId);

// Ids of Meta objects go into the URL path of the Graph API and into the
// log, so only digits and "_" (Facebook ids are <page>_<post>). No "/" or
// "." that could point the call at another node.
const PLATFORM_ID_PATTERN = /^[0-9_]{1,64}$/;

export const isPlatformId = (value: unknown): value is string =>
  typeof value === 'string' && PLATFORM_ID_PATTERN.test(value);

// Latest posts per read and comments per post. Instagram returns at most 50
// comments per query, newest first.
export const INBOX_POSTS_LIMIT = 10;
export const INBOX_COMMENTS_LIMIT = 50;

// Upper bound for a reply, like maxLength() of the Postiz Instagram
// provider. The platform may reject shorter texts, then the route answers
// platform_error.
export const INBOX_REPLY_MAX_LENGTH = 2200;

export interface InboxReply {
  id: string;
  text: string;
  username: string | null;
  timestamp: string | null;
  likeCount: number;
  hidden: boolean;
}

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
 * One inbox provider per Postiz provider identifier (E25 variant B: own
 * provider files in libraries/ysocial/src/inbox/, with the tokens of the
 * Postiz channels, without a Postiz patch).
 */
export interface YsocialInboxProvider {
  identifier: string;
  listComments(channel: InboxChannel): Promise<InboxPost[]>;
  // true only if the comment is on a post of this channel.
  ownsComment(channel: InboxChannel, commentId: string): Promise<boolean>;
  // id of the new reply, null if the platform did not return one.
  reply(
    channel: InboxChannel,
    commentId: string,
    message: string
  ): Promise<{ id: string | null }>;
  hide(channel: InboxChannel, commentId: string, hide: boolean): Promise<void>;
  remove(channel: InboxChannel, commentId: string): Promise<void>;
}

/**
 * The platform refused a call or could not be reached. Only codes and a
 * sanitized reason, never the token, the URL or a comment text.
 * message carries the codes only, so a log of err.message stays clean.
 */
export class InboxPlatformError extends Error {
  constructor(
    readonly details: {
      unavailable: boolean;
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
          }/${details.subcode ?? '-'}`
    );
    this.name = 'InboxPlatformError';
  }
}
