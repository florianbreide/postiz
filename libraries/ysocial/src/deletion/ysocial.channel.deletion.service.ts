import { Injectable, Logger } from '@nestjs/common';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { HubEvent } from '../events/hub.event';
import {
  DeletionMediaRow,
  YsocialDeletionRepository,
} from '../database/ysocial.deletion.repository';
import {
  channelDataDeletedEvent,
  ChannelDeletionResult,
  DELETION_CHANNELS_PER_RUN,
  DELETION_MEDIA_BUDGET_MS,
  deletionEnabled,
  deletionOverdue,
  graceCutoff,
  grantIdentities,
  inOwnStorage,
  MediaCount,
  postMediaRefs,
  RevokePlan,
  revokeEnabled,
  revokeFinal,
  revokePlan,
  RevokeResult,
  storageLocation,
} from './deletion.rules';
import { PLATFORM_REVOKERS } from './platform.revoke';

export interface ChannelDeletionDue {
  dryRun: boolean;
  // Deleted before the cutoff and still with a token.
  due: number;
  // The oldest of them, at most DELETION_CHANNELS_PER_RUN.
  integrationIds: string[];
}

// The channel without its tokens.
interface DeletionRow {
  id: string;
  organizationId: string;
  customerId: string | null;
  internalId: string;
  rootInternalId: string | null;
  providerIdentifier: string;
  deletedAt: Date;
  updatedAt: Date | null;
}

interface StoredTokens {
  token: string;
  refreshToken: string | null;
}

export interface YsocialFileStore {
  removeFile(filePath: string): Promise<void>;
}

// The token extension decrypts on the first access and throws on a value it
// cannot read. undefined: unreadable, the job can still clear it.
const readTokens = (row: {
  token: string;
  refreshToken: string | null;
}): StoredTokens | undefined => {
  try {
    return { token: row.token || '', refreshToken: row.refreshToken || null };
  } catch (err) {
    return undefined;
  }
};

const errorName = (err: unknown) =>
  err instanceof Error ? err.name : 'unknown';

/**
 * Deletion of disconnected channels (Datenschutz D1). Rules and the reasons
 * for them in deletion.rules.ts, the platform calls in platform.revoke.ts.
 *
 * Per channel, once its grace period is over and while it still holds a
 * token:
 * 1. Revoke at the platform, only with YSOCIAL_DELETION_REVOKE=true and only
 *    if no other channel of the platform family that is connected or still
 *    in its grace period shares the authorization. Right before the call
 *    that ends it, the job checks once more that the channel is unchanged
 *    and nobody shares it.
 * 2. Media of its posts that nothing else uses: the files, then the rows.
 * 3. Clear token and refreshToken, only if the row is still as read.
 * Steps 1 and 2 are tried again in the next run until the deadline, then the
 * tokens are cleared anyway, also when the job itself fails.
 *
 * Without YSOCIAL_DELETION_ENABLED=true a dry run: the database is read, no
 * platform call, no write, no event.
 *
 * The tokens are read here and passed to the platform, they never leave this
 * class: not in a result, an event or a log.
 */
@Injectable()
export class YsocialChannelDeletionService {
  private readonly _logger = new Logger('ysocial');
  protected files: () => YsocialFileStore = () => UploadFactory.createStorage();
  // Wall clock for the media budget, set in tests.
  protected clock = () => Date.now();

  constructor(private _repository: YsocialDeletionRepository) {}

  async findDue(now: Date = new Date()): Promise<ChannelDeletionDue> {
    const dryRun = !deletionEnabled(process.env);
    const rows = await this._repository.getDeletedChannels(graceCutoff(now));
    // An unreadable token counts as one: the job clears it at the deadline.
    const due = rows.filter((row) => {
      const tokens = readTokens(row);
      return !tokens || !!tokens.token || !!tokens.refreshToken;
    });
    if (due.length) {
      this._logger.log(
        `channel deletion: due=${due.length} mode=${dryRun ? 'dry-run' : 'on'}`
      );
    }
    return {
      dryRun,
      due: due.length,
      integrationIds: due
        .slice(0, DELETION_CHANNELS_PER_RUN)
        .map((row) => row.id),
    };
  }

  // null: nothing to do, the channel is connected again, still in its grace
  // period or already done.
  async deleteChannelData(
    integrationId: string,
    now: Date = new Date()
  ): Promise<{ result: ChannelDeletionResult | null; event?: HubEvent }> {
    const row = await this._repository.getChannelForDeletion(integrationId);
    if (!row?.deletedAt || row.deletedAt > graceCutoff(now)) {
      return { result: null };
    }
    const tokens = readTokens(row);
    if (tokens && !tokens.token && !tokens.refreshToken) {
      return { result: null };
    }

    const channel: DeletionRow = {
      id: row.id,
      organizationId: row.organizationId,
      customerId: row.customerId,
      internalId: row.internalId,
      rootInternalId: row.rootInternalId,
      providerIdentifier: row.providerIdentifier,
      deletedAt: row.deletedAt,
      updatedAt: row.updatedAt,
    };
    const dryRun = !deletionEnabled(process.env);
    const overdue = deletionOverdue(channel.deletedAt, now);
    const media: MediaCount = { deleted: 0, kept: 0, failed: 0, left: 0 };
    const report = (
      status: ChannelDeletionResult['status'],
      revoke: RevokePlan | RevokeResult
    ): ChannelDeletionResult => {
      const result: ChannelDeletionResult = {
        integrationId: channel.id,
        providerIdentifier: channel.providerIdentifier,
        mode: dryRun ? 'dry_run' : 'on',
        status,
        revoke,
        media: { ...media },
        overdue,
      };
      this.logResult(result);
      return result;
    };

    if (dryRun) {
      const plan = await this.planRevoke(channel, now);
      await this.cleanupMedia(channel, true, media);
      return { result: report('planned', plan) };
    }

    let revoke: RevokeResult = 'failed';
    let complete = false;
    try {
      const plan = await this.planRevoke(channel, now);
      revoke = plan === 'revoke' ? 'failed' : plan;
      if (plan === 'revoke' && tokens) {
        revoke = await this.revoke(channel, tokens, now);
      }
      // Connected again or written by Postiz meanwhile: nothing more happens
      // to it in this run.
      if (
        revoke === 'changed_meanwhile' ||
        !(await this._repository.isUnchanged(channel))
      ) {
        return { result: report('skipped', revoke) };
      }
      await this.cleanupMedia(channel, false, media);
      complete = revokeFinal(revoke) && !media.failed && !media.left;
    } catch (err) {
      // Past the deadline the tokens go even when the job fails, otherwise
      // the next run tries again. A channel that always fails would else
      // block the oldest places of every run.
      if (!overdue) {
        throw err;
      }
      this._logger.warn(
        `channel deletion channel=${channel.id} failed: ${errorName(err)}`
      );
    }

    if (!complete && !overdue) {
      return { result: report('retry', revoke) };
    }
    const cleared = await this._repository.clearTokens(channel);
    if (!cleared) {
      return { result: report('skipped', revoke) };
    }
    return {
      result: report('deleted', revoke),
      event: channelDataDeletedEvent(channel, revoke, media, overdue, now),
    };
  }

  private async planRevoke(row: DeletionRow, now: Date): Promise<RevokePlan> {
    const revoker = PLATFORM_REVOKERS[row.providerIdentifier];
    const revokeOn = revokeEnabled(process.env);
    const holders =
      revoker && revokeOn && row.rootInternalId
        ? await this._repository.getGrantHolders({
            id: row.id,
            providers: revoker.family,
            identities: grantIdentities(row),
            graceCutoff: graceCutoff(now),
          })
        : [];
    return revokePlan(row, !!revoker, revokeOn, holders);
  }

  private async revoke(
    row: DeletionRow,
    tokens: StoredTokens,
    now: Date
  ): Promise<RevokeResult> {
    const revoker = PLATFORM_REVOKERS[row.providerIdentifier];
    const prepared = await revoker.prepare({
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      identities: grantIdentities(row),
    });

    let result: RevokeResult;
    if ('result' in prepared) {
      result = prepared.result;
    } else if (!(await this._repository.isUnchanged(row))) {
      result = 'changed_meanwhile';
    } else {
      // A channel connected during the preparing calls shares it now.
      const plan = await this.planRevoke(row, now);
      result = plan === 'revoke' ? await revoker.revoke(prepared.token) : plan;
    }

    this._logger.log(
      `provider call revoke provider=${row.providerIdentifier} channel=${row.id} result=${result}`
    );

    // The window between the last check and the revoke is short, but not
    // zero. Whoever connected the account in it has a dead token now. Only a
    // warning: a failing check must not hide that the revoke happened.
    if (result === 'revoked') {
      try {
        if (
          !(await this._repository.isUnchanged(row)) ||
          (await this.planRevoke(row, now)) !== 'revoke'
        ) {
          this._logger.warn(
            `channel deletion channel=${row.id} revoked, but the account was connected meanwhile: connect it again`
          );
        }
      } catch (err) {
        this._logger.warn(
          `channel deletion channel=${
            row.id
          } revoked, check afterwards failed: ${errorName(err)}`
        );
      }
    }
    return result;
  }

  // Counts into media, so a failure halfway keeps what was done.
  private async cleanupMedia(
    row: DeletionRow,
    dryRun: boolean,
    media: MediaCount
  ) {
    const posts = await this._repository.getPostMedia(row.id);
    const refs = postMediaRefs(
      ...posts.flatMap((post) => [post.image, post.settings])
    );
    if (!refs.ids.length && !refs.paths.length) {
      return;
    }

    const items = await this._repository.getMedia(
      row.organizationId,
      refs.ids,
      refs.paths
    );
    const location = storageLocation(process.env);
    const store = dryRun ? undefined : this.files();
    const startedAt = this.clock();

    for (const [index, item] of items.entries()) {
      if (this.clock() - startedAt > DELETION_MEDIA_BUDGET_MS) {
        media.left = items.length - index;
        break;
      }
      const files = [item.path, item.thumbnail].filter(
        (value): value is string => !!value
      );
      if (
        !files.every((file) => inOwnStorage(file, location)) ||
        item._count.userPicture ||
        item._count.agencies ||
        item._count.oauthApps ||
        (await this._repository.mediaInUse(item))
      ) {
        media.kept++;
        continue;
      }
      if (!store) {
        media.deleted++;
        continue;
      }
      if (await this.deleteMedia(store, item, row.organizationId, files)) {
        media.deleted++;
      } else {
        media.failed++;
      }
    }
  }

  // The files first: a row whose file could not go stays for the next run.
  private async deleteMedia(
    store: YsocialFileStore,
    item: DeletionMediaRow,
    organizationId: string,
    files: string[]
  ) {
    try {
      for (const file of files) {
        await store.removeFile(file).catch((err) => {
          // Already gone counts as removed.
          if (err?.code !== 'ENOENT') {
            throw err;
          }
        });
      }
      await this._repository.deleteMedia(item.id, organizationId);
      return true;
    } catch (err) {
      this._logger.warn(
        `channel deletion media=${item.id} failed: ${errorName(err)}`
      );
      return false;
    }
  }

  private logResult(result: ChannelDeletionResult) {
    const { media } = result;
    this._logger.log(
      `channel deletion channel=${result.integrationId} provider=${
        result.providerIdentifier
      } mode=${result.mode === 'dry_run' ? 'dry-run' : 'on'} status=${
        result.status
      } revoke=${result.revoke} media deleted=${media.deleted} kept=${
        media.kept
      } failed=${media.failed} left=${media.left}${
        result.overdue ? ' overdue' : ''
      }`
    );
  }
}
