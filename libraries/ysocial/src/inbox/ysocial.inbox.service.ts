import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { YsocialInboxRepository } from '../database/ysocial.inbox.repository';
import { channelFlag, ChannelRow } from '../health/channel.health';
import { parseActor } from '../retry/retry.rules';
import {
  InboxCapabilities,
  InboxChannel,
  InboxItemsQuery,
  InboxOwnershipUnknownError,
  InboxPlatformError,
  InboxPost,
  InboxUsageMeter,
  inboxEnabled,
  inboxWindow,
  isDemoIntegration,
  isIntegrationId,
  isPlatformId,
  YSOCIAL_DEMO_INTEGRATIONS_ENV,
  YsocialInboxProvider,
} from './inbox.rules';
import { inboxEventsEnabled } from '../webhooks/webhook.rules';
import { InstagramInbox } from './instagram.inbox';
import { FacebookInbox } from './facebook.inbox';

type Rejection = { status: number; code: string; [field: string]: unknown };
type Log = (result: string) => void;

// inbox: channels of YSOCIAL_DEMO_INTEGRATIONS, and with
// YSOCIAL_INBOX_ENABLED=true every channel (PR 73). webhooks: those of the
// demo list, and with YSOCIAL_INBOX_EVENTS=true every channel (PR 74).
type Scope = 'inbox' | 'webhooks';

const SCOPE_SWITCH: Record<Scope, (env: NodeJS.ProcessEnv) => boolean> = {
  inbox: inboxEnabled,
  webhooks: inboxEventsEnabled,
};

const allowedFor = (integrationId: string, scope: Scope) =>
  isDemoIntegration(process.env, integrationId) ||
  (SCOPE_SWITCH[scope](process.env) && isIntegrationId(integrationId));

const usageLog = (usage?: InboxUsageMeter) =>
  usage?.usage ? ` usage=${usage.usage.percent}` : '';

// The post of a comment as the hub knows it from items: a hint for the
// search, the provider checks it (PR 73, E92). Only a valid id counts.
const hintOf = (postId: string | undefined) =>
  isPlatformId(postId) ? postId : null;

const rejection = ({ status, ...body }: Rejection) =>
  new HttpException({ statusCode: status, ...body }, status);

// Class name of an unexpected error for the log, never its message. A
// Prisma error code (P1001: database not reachable) carries no data.
const errorName = (err: unknown) => {
  const name =
    err instanceof Error && /^\w{1,60}$/.test(err.name) ? err.name : 'Error';
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^P\d{4}$/.test(code)
    ? `${name} code=${code}`
    : name;
};

const countComments = (posts: InboxPost[]) =>
  posts.reduce(
    (sum, post) =>
      sum +
      post.comments.reduce((n, comment) => n + 1 + comment.replies.length, 0),
    0
  );

/**
 * Inbox demo for the Meta screencasts (PLAN 3.3 PR 26, E25). Reads the
 * comments of the latest posts, replies as the account, hides and deletes.
 * Puts our app on the Page of the channel for webhooks (PR B), the receiver
 * is YsocialMetaWebhookService.
 *
 * - Only for channels in YSOCIAL_DEMO_INTEGRATIONS, checked here for every
 *   call, read and write (rule 9). The guard only decides whether the
 *   routes exist.
 * - Writes only on a call of a person through the route (rule 2). The hub
 *   checks the role and sends who it was in X-Ysocial-Actor. Delete needs
 *   {"confirmDelete": true}. A write happens only on a comment on a post of
 *   the channel itself (ownsComment of the provider).
 * - The log gets ids, the actor and counts. Never a comment text, the name
 *   of a commenter, a token or the message of the platform.
 * - Unexpected errors become 500 internal_error. As an HttpException they
 *   stay out of the Sentry filter of Postiz, which would attach the request
 *   body (the text of a reply).
 * - Nothing is stored.
 */
@Injectable()
export class YsocialInboxService {
  private readonly _logger = new Logger('ysocial');

  // One inbox provider per Postiz provider identifier. Facebook reads Page
  // comments with pages_read_user_content, which the Postiz provider asks
  // for since ysocial patch 4 (scopes/meta.scopes.ts). Pages connected
  // before carry it only after they are connected again.
  protected providers: Record<string, YsocialInboxProvider> = {
    instagram: new InstagramInbox(),
    facebook: new FacebookInbox(),
  };

  constructor(private _inbox: YsocialInboxRepository) {}

  async getComments(integrationId: string) {
    const listed = allowedFor(integrationId, 'inbox');
    const log: Log = (result) =>
      this._logger.log(
        `inbox comments channel=${
          listed ? integrationId : '-'
        } result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        'inbox',
        log
      );
      const posts = await this.platform(log, () =>
        provider.listComments(channel)
      );
      log(`ok posts=${posts.length} comments=${countComments(posts)}`);
      return {
        integrationId,
        provider: provider.identifier,
        fetchedAt: new Date().toISOString(),
        posts,
      };
    });
  }

  reply(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    message: string,
    postId?: string
  ) {
    return this.write(
      'reply',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        const { id } = await provider.reply(channel, commentId, message);
        return { integrationId, commentId, replyId: id };
      },
      { postId }
    );
  }

  hide(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    hide: boolean,
    postId?: string
  ) {
    return this.write(
      hide ? 'hide' : 'unhide',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        await provider.hide(channel, commentId, hide);
        return { integrationId, commentId, hidden: hide };
      },
      { postId }
    );
  }

  remove(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    confirmDelete: boolean,
    postId?: string
  ) {
    return this.write(
      'delete',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        await provider.remove(channel, commentId);
        return { integrationId, commentId, deleted: true };
      },
      { postId, confirmed: confirmDelete }
    );
  }

  // Like or unlike as the Page (PR 73). Only where the platform has it
  // (capabilities.like, Facebook), otherwise 409 action_not_supported.
  like(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    like: boolean,
    postId?: string
  ) {
    return this.write(
      like ? 'like' : 'unlike',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        await provider.like(channel, commentId, like);
        return { integrationId, commentId, liked: like };
      },
      { postId, capability: 'like' }
    );
  }

  // What the platform of the channel allows (E84, W69). No platform call.
  async getCapabilities(integrationId: string) {
    const listed = allowedFor(integrationId, 'inbox');
    const log: Log = (result) =>
      this._logger.log(
        `inbox capabilities channel=${
          listed ? integrationId : '-'
        } result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider } = await this.channelFor(integrationId, 'inbox', log);
      log('ok');
      return {
        integrationId,
        provider: provider.identifier,
        capabilities: provider.capabilities,
      };
    });
  }

  // Comments and replies of the posts in the window since a time (PR 73,
  // E82). One page per call, nextCursor continues it.
  async getItems(integrationId: string, query: InboxItemsQuery) {
    const listed = allowedFor(integrationId, 'inbox');
    const log: Log = (result) =>
      this._logger.log(
        `inbox items channel=${listed ? integrationId : '-'} result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        'inbox',
        log
      );
      const now = new Date();
      const window = inboxWindow(query, now);
      const usage = new InboxUsageMeter();
      const page = await this.platform(
        log,
        () => provider.listItems(channel, window, usage),
        false,
        usage
      );
      log(
        `ok posts=${page.posts.length} items=${page.items.length} next=${
          page.nextCursor ? 'yes' : 'no'
        }${usageLog(usage)}`
      );
      return {
        integrationId,
        provider: provider.identifier,
        fetchedAt: now.toISOString(),
        since: window.since?.toISOString() ?? null,
        postsFrom: window.postsFrom?.toISOString() ?? null,
        postsBefore: window.postsBefore?.toISOString() ?? null,
        ...page,
        usage: usage.usage,
      };
    });
  }

  // One comment of this channel with its conversation (PR 73): for the
  // webhook bell and for reloading a ticket. A comment of another account
  // is 404 comment_not_found, as for a write. postId: see hintOf.
  async getComment(integrationId: string, commentId: string, postId?: string) {
    const listed = allowedFor(integrationId, 'inbox');
    const validComment = isPlatformId(commentId);
    const log: Log = (result) =>
      this._logger.log(
        `inbox comment channel=${listed ? integrationId : '-'} comment=${
          validComment ? commentId : '-'
        } result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        'inbox',
        log,
        () =>
          validComment ? undefined : { status: 400, code: 'invalid_comment_id' }
      );
      const usage = new InboxUsageMeter();
      const conversation = await this.platform(
        log,
        () =>
          provider.getConversation(channel, commentId, usage, hintOf(postId)),
        false,
        usage
      );
      if (!conversation) {
        log('rejected code=comment_not_found');
        throw rejection({ status: 404, code: 'comment_not_found' });
      }
      log(`ok items=${conversation.items.length}${usageLog(usage)}`);
      return {
        integrationId,
        provider: provider.identifier,
        fetchedAt: new Date().toISOString(),
        commentId,
        ...conversation,
        usage: usage.usage,
      };
    });
  }

  // Whether our app is on the Page of the channel, with which Page fields
  // (PR B). Read only. The demo list, and with YSOCIAL_INBOX_EVENTS=true
  // every channel (PR 74).
  async getWebhooks(integrationId: string) {
    const listed = allowedFor(integrationId, 'webhooks');
    const log: Log = (result) =>
      this._logger.log(
        `inbox webhooks channel=${
          listed ? integrationId : '-'
        } result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        'webhooks',
        log
      );
      const { subscribed, fields } = await this.platform(log, () =>
        provider.webhookSubscription(channel)
      );
      log(`ok subscribed=${subscribed} fields=${fields.join(',') || '-'}`);
      return {
        integrationId,
        provider: provider.identifier,
        subscribed,
        fields,
      };
    });
  }

  // Puts our app on the Page of the channel with the field feed (PR B), for
  // every channel with YSOCIAL_INBOX_EVENTS=true (PR 74). A write at Meta
  // like a reply: only on a call of a person, with the actor. The hub lets
  // only an admin trigger it (E97).
  subscribeWebhooks(integrationId: string, actorHeader: string | undefined) {
    return this.write(
      'subscribe',
      integrationId,
      null,
      actorHeader,
      async (provider, channel) => {
        const { fields } = await provider.subscribeWebhooks(channel);
        return {
          integrationId,
          provider: provider.identifier,
          subscribed: true,
          fields,
        };
      },
      { scope: 'webhooks' }
    );
  }

  // commentId null: a write on the channel itself, without a comment and
  // without the ownership check of a comment. capability: the write needs
  // this capability of the platform, checked before any platform call.
  // postId: see hintOf.
  private async write<T>(
    action: string,
    integrationId: string,
    commentId: string | null,
    actorHeader: string | undefined,
    run: (provider: YsocialInboxProvider, channel: InboxChannel) => Promise<T>,
    {
      confirmed = true,
      capability,
      scope = 'inbox',
      postId,
    }: {
      confirmed?: boolean;
      capability?: keyof InboxCapabilities;
      scope?: Scope;
      postId?: string;
    } = {}
  ): Promise<T> {
    const actor = parseActor(actorHeader);
    if (!actor) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'actor_missing',
        message: 'X-Ysocial-Actor is required: an e-mail address or an id',
      });
    }

    // Only ids that passed a check go into the log, never a raw path.
    const listed = allowedFor(integrationId, scope);
    const validComment = commentId === null || isPlatformId(commentId);
    const comment =
      commentId === null ? '' : ` comment=${validComment ? commentId : '-'}`;
    const log: Log = (result) =>
      this._logger.log(
        `inbox ${action} channel=${
          listed ? integrationId : '-'
        }${comment} actor=${actor} result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        scope,
        log,
        () => {
          if (!validComment) {
            return { status: 400, code: 'invalid_comment_id' };
          }
          if (!confirmed) {
            return { status: 409, code: 'confirmation_required' };
          }
          return undefined;
        }
      );

      if (capability && !provider.capabilities[capability]) {
        log('rejected code=action_not_supported');
        throw rejection({
          status: 409,
          code: 'action_not_supported',
          provider: provider.identifier,
        });
      }

      if (commentId !== null) {
        const owned = await this.platform(log, () =>
          provider.ownsComment(channel, commentId, hintOf(postId))
        );
        if (!owned) {
          log('rejected code=comment_not_found');
          throw rejection({ status: 404, code: 'comment_not_found' });
        }
      }

      const result = await this.platform(
        log,
        () => run(provider, channel),
        true
      );
      log('done');
      return result;
    });
  }

  // Checks in this order: listed channel, the checks of the call (before
  // the database), channel in Postiz, active, provider with an inbox.
  private async channelFor(
    integrationId: string,
    scope: Scope,
    log: Log,
    precheck: () => Rejection | undefined = () => undefined
  ) {
    const reject = (body: Rejection) => {
      log(`rejected code=${body.code}`);
      return rejection(body);
    };

    // Not listed and without the switch of the scope. With the switch an id
    // that is no Postiz id gets here as well.
    if (!allowedFor(integrationId, scope)) {
      if (SCOPE_SWITCH[scope](process.env) && !isIntegrationId(integrationId)) {
        throw reject({ status: 404, code: 'not_found' });
      }
      throw reject({
        status: 403,
        code: 'not_demo_integration',
        message: `channel is not listed in ${YSOCIAL_DEMO_INTEGRATIONS_ENV}`,
      });
    }
    const failed = precheck();
    if (failed) {
      throw reject(failed);
    }

    const row = await this._inbox.getChannelForInbox(integrationId);
    if (!row) {
      throw reject({ status: 404, code: 'not_found' });
    }
    const flag = row.deletedAt
      ? 'deleted'
      : channelFlag(row as unknown as ChannelRow);
    if (flag) {
      throw reject({ status: 409, code: 'channel_inactive', flag });
    }
    const provider = this.providers[row.providerIdentifier];
    if (!provider) {
      throw reject({
        status: 409,
        code: 'provider_not_supported',
        provider: row.providerIdentifier,
      });
    }

    return {
      provider,
      channel: { internalId: row.internalId, token: row.token },
    };
  }

  // Platform errors become 502 platform_error (with the codes and the
  // sanitized message of the platform) or 503 platform_unavailable. The log
  // gets the codes only. Without a clear answer to the write itself
  // (network error, timeout, a 5xx of Meta, a 2xx without a readable body)
  // the outcome is unknown: Meta may have done it. Then 503 outcome_unknown,
  // and the hub reloads the comments instead of repeating the call. A search
  // for a comment that ran out of time is 503 ownership_unknown, nothing
  // written. usage: the load at Meta so far, also on an error (a rate limit).
  private async platform<T>(
    log: Log,
    call: () => Promise<T>,
    writing = false,
    usage?: InboxUsageMeter
  ): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof InboxOwnershipUnknownError) {
        log(`rejected code=ownership_unknown${usageLog(usage)}`);
        throw rejection({
          status: 503,
          code: 'ownership_unknown',
          ...(usage?.usage ? { usage: usage.usage } : {}),
        });
      }
      if (!(err instanceof InboxPlatformError)) {
        throw err;
      }
      const load = usage?.usage ? { usage: usage.usage } : {};
      const { unavailable, unreadable, status, code, subcode, reason } =
        err.details;
      const body = unreadable ? ' body=unreadable' : '';
      if (writing && (unavailable || unreadable || (status ?? 0) >= 500)) {
        log(
          `rejected code=outcome_unknown${
            unavailable
              ? ''
              : ` status=${status} platform=${code ?? '-'}/${
                  subcode ?? '-'
                }${body}`
          }`
        );
        throw rejection({ status: 503, code: 'outcome_unknown' });
      }
      if (unavailable) {
        log(`rejected code=platform_unavailable${usageLog(usage)}`);
        throw rejection({ status: 503, code: 'platform_unavailable', ...load });
      }
      log(
        `rejected code=platform_error status=${status ?? '-'} platform=${
          code ?? '-'
        }/${subcode ?? '-'}${body}${usageLog(usage)}`
      );
      throw rejection({
        status: 502,
        code: 'platform_error',
        platformStatus: status ?? null,
        platformCode: code ?? null,
        platformSubcode: subcode ?? null,
        reason: reason || null,
        ...load,
      });
    }
  }

  // Unexpected errors (database, decryption of the token, a bug) become 500
  // internal_error. The log gets the class name only, never the message.
  private async guarded<T>(log: Log, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      log(`rejected code=internal_error error=${errorName(err)}`);
      throw rejection({ status: 500, code: 'internal_error' });
    }
  }
}
