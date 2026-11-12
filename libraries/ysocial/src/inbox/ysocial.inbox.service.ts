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
  InboxChannel,
  InboxPlatformError,
  InboxPost,
  isDemoIntegration,
  isPlatformId,
  YSOCIAL_DEMO_INTEGRATIONS_ENV,
  YsocialInboxProvider,
} from './inbox.rules';
import { InstagramInbox } from './instagram.inbox';

type Rejection = { status: number; code: string; [field: string]: unknown };
type Log = (result: string) => void;

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
 *
 * - Only for channels in YSOCIAL_DEMO_INTEGRATIONS, checked here for every
 *   call, read and write (rule 9). The guard only decides whether the
 *   routes exist.
 * - Writes only on a call of a person through the route (rule 2). The hub
 *   checks the role and sends who it was in X-Ysocial-Actor. Delete needs
 *   {"confirmDelete": true}. A write happens only on a comment on media of
 *   the channel itself.
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

  // One inbox provider per Postiz provider identifier. Facebook is missing
  // on purpose: reading Page comments needs pages_read_user_content, which
  // the Postiz provider does not ask for (W10).
  protected providers: Record<string, YsocialInboxProvider> = {
    instagram: new InstagramInbox(),
  };

  constructor(private _inbox: YsocialInboxRepository) {}

  async getComments(integrationId: string) {
    const listed = isDemoIntegration(process.env, integrationId);
    const log: Log = (result) =>
      this._logger.log(
        `inbox comments channel=${
          listed ? integrationId : '-'
        } result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        listed,
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
    message: string
  ) {
    return this.write(
      'reply',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        const { id } = await provider.reply(channel, commentId, message);
        return { integrationId, commentId, replyId: id };
      }
    );
  }

  hide(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    hide: boolean
  ) {
    return this.write(
      hide ? 'hide' : 'unhide',
      integrationId,
      commentId,
      actorHeader,
      async (provider, channel) => {
        await provider.hide(channel, commentId, hide);
        return { integrationId, commentId, hidden: hide };
      }
    );
  }

  remove(
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    confirmDelete: boolean
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
      confirmDelete
    );
  }

  private async write<T>(
    action: string,
    integrationId: string,
    commentId: string,
    actorHeader: string | undefined,
    run: (provider: YsocialInboxProvider, channel: InboxChannel) => Promise<T>,
    confirmed = true
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
    const listed = isDemoIntegration(process.env, integrationId);
    const validComment = isPlatformId(commentId);
    const log: Log = (result) =>
      this._logger.log(
        `inbox ${action} channel=${listed ? integrationId : '-'} comment=${
          validComment ? commentId : '-'
        } actor=${actor} result=${result}`
      );

    return this.guarded(log, async () => {
      const { provider, channel } = await this.channelFor(
        integrationId,
        listed,
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

      const owned = await this.platform(log, () =>
        provider.ownsComment(channel, commentId)
      );
      if (!owned) {
        log('rejected code=comment_not_found');
        throw rejection({ status: 404, code: 'comment_not_found' });
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
    listed: boolean,
    log: Log,
    precheck: () => Rejection | undefined = () => undefined
  ) {
    const reject = (body: Rejection) => {
      log(`rejected code=${body.code}`);
      return rejection(body);
    };

    if (!listed) {
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
  // (network error, timeout, a 5xx of Meta) the outcome is unknown: Meta may
  // have done it. Then 503 outcome_unknown, and the hub reloads the comments
  // instead of repeating the call.
  private async platform<T>(
    log: Log,
    call: () => Promise<T>,
    writing = false
  ): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof InboxPlatformError)) {
        throw err;
      }
      const { unavailable, status, code, subcode, reason } = err.details;
      if (writing && (unavailable || (status ?? 0) >= 500)) {
        log(
          `rejected code=outcome_unknown${
            unavailable
              ? ''
              : ` status=${status} platform=${code ?? '-'}/${subcode ?? '-'}`
          }`
        );
        throw rejection({ status: 503, code: 'outcome_unknown' });
      }
      if (unavailable) {
        log('rejected code=platform_unavailable');
        throw rejection({ status: 503, code: 'platform_unavailable' });
      }
      log(
        `rejected code=platform_error status=${status ?? '-'} platform=${
          code ?? '-'
        }/${subcode ?? '-'}`
      );
      throw rejection({
        status: 502,
        code: 'platform_error',
        platformStatus: status ?? null,
        platformCode: code ?? null,
        platformSubcode: subcode ?? null,
        reason: reason || null,
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
