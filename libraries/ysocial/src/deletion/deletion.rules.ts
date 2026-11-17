import { createHubEvent, HubEvent } from '../events/hub.event';

/**
 * Deletion of disconnected channels (Datenschutz D1, hub
 * docs/rechtliches/datenschutz-entwurf.md Teil D Punkt 1).
 *
 * Postiz only sets Integration.deletedAt when a channel is deleted. The token
 * stays valid at the platform and in the database, the media of its posts
 * stay in storage. After a grace period the job revokes the authorization
 * where that is safe (platform.revoke.ts), deletes the media no one else uses
 * and clears the stored tokens.
 *
 * Pure rules, no Nest, no Prisma. The service is ysocial.channel.deletion
 * .service.ts, the description apps/orchestrator/src/ysocial/README.md.
 */

export const YSOCIAL_DELETION_ENABLED_ENV = 'YSOCIAL_DELETION_ENABLED';
export const YSOCIAL_DELETION_REVOKE_ENV = 'YSOCIAL_DELETION_REVOKE';

// Only "true" deletes. Anything else, also a missing value, is a dry run: it
// counts and logs, without a platform call and without a write (fail-closed).
export const deletionEnabled = (env: NodeJS.ProcessEnv) =>
  env[YSOCIAL_DELETION_ENABLED_ENV] === 'true';

// The revoke at the platform needs its own "true". It ends the authorization
// of the account in every environment that uses the same platform app, so it
// is switched on in one environment only. Without it the job clears the
// tokens and deletes the media, nothing else.
export const revokeEnabled = (env: NodeJS.ProcessEnv) =>
  env[YSOCIAL_DELETION_REVOKE_ENV] === 'true';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

// Admins delete channels by mistake. Connecting the channel again brings back
// the same row with deletedAt null (createOrUpdateIntegration), the job never
// sees it. With a page selection Postiz instead gives the deleted row a
// random internalId (checkForDeletedOnceAndUpdate) and connects a new row:
// the job never touches the new row.
// 6, not 7 days: YouTube wants the data deleted within 7 days after the user
// revoked access through our own tool (Developer Policies III.D.2.3,
// III.E.4). The hourly runs of the last day are the retries.
export const DELETION_GRACE_DAYS = 6;
// From here the tokens are cleared even when the revoke or the media still
// fail. 2 hours before the 7 days: the runs come hourly at a quarter to, and
// a run may have to wait for older channels.
export const DELETION_DEADLINE_MS = 7 * DAY_MS - 2 * HOUR_MS;

// Channels per run, the oldest first. The rest follows in the next run.
export const DELETION_CHANNELS_PER_RUN = 25;

// Time for the media of one channel. The activity has 10 minutes and no
// heartbeat (ysocial.channel.deletion.workflow.ts): media not checked by
// then wait for the next run.
export const DELETION_MEDIA_BUDGET_MS = 7 * 60_000;

export const graceCutoff = (now: Date) =>
  new Date(now.getTime() - DELETION_GRACE_DAYS * DAY_MS);

export const deletionOverdue = (deletedAt: Date, now: Date) =>
  now.getTime() >= deletedAt.getTime() + DELETION_DEADLINE_MS;

/**
 * What became of the authorization at the platform.
 *
 * Final, the tokens may go:
 * - revoked: the platform confirmed the revoke.
 * - already_invalid: the platform says the token is invalid, expired or
 *   revoked. There is nothing left to revoke with it.
 * - no_refresh_token: TikTok, no refresh token stored. The access token
 *   expired after 24 hours, there is nothing to revoke with.
 * - token_mismatch: the token belongs to another account than the row says.
 *   The check of the other channels looked at the wrong account, so no
 *   revoke.
 * - not_supported: the job does not revoke for this platform (Meta and
 *   Google not safely, LinkedIn, Instagram Login and the rest have no
 *   documented revoke, see platform.revoke.ts). Only the tokens are cleared.
 * - revoke_off: YSOCIAL_DELETION_REVOKE is not "true".
 * - shared_grant: another channel that is connected, or deleted but still in
 *   its grace period, shares the authorization. A revoke would end it too.
 * - grant_unknown: the row or such a channel has no rootInternalId, so it is
 *   unclear who shares the authorization. No revoke (fail-closed).
 *
 * Not final, the next run tries again until the deadline:
 * - failed: no clear answer (network, timeout, 5xx, unexpected body), or an
 *   error of the job itself.
 * - not_configured: the client credentials of the platform are missing.
 *
 * changed_meanwhile: the channel changed between reading and revoking, for
 * example connected again. Nothing happens to it in this run.
 */
export const REVOKE_RESULTS = [
  'revoked',
  'already_invalid',
  'no_refresh_token',
  'token_mismatch',
  'not_supported',
  'revoke_off',
  'shared_grant',
  'grant_unknown',
  'failed',
  'not_configured',
  'changed_meanwhile',
] as const;

export type RevokeResult = (typeof REVOKE_RESULTS)[number];

const FINAL_REVOKE_RESULTS: RevokeResult[] = [
  'revoked',
  'already_invalid',
  'no_refresh_token',
  'token_mismatch',
  'not_supported',
  'revoke_off',
  'shared_grant',
  'grant_unknown',
];

export const revokeFinal = (result: RevokeResult) =>
  FINAL_REVOKE_RESULTS.includes(result);

// The decision before any platform call: revoke, or why not.
export type RevokePlan =
  | 'revoke'
  | 'not_supported'
  | 'revoke_off'
  | 'shared_grant'
  | 'grant_unknown';

export interface GrantRow {
  internalId: string;
  rootInternalId: string | null;
}

// Ids that name the account behind a row. Postiz renames a row it replaces
// after the page selection to deleted_<internalId>_<makeId(10)>
// (integration.repository.ts, updateIntegration), both forms count.
export const grantIdentities = (row: GrantRow): string[] => {
  const ids = new Set<string>();
  for (const id of [row.rootInternalId, row.internalId]) {
    if (!id) {
      continue;
    }
    ids.add(id);
    const original = id.match(/^deleted_(.+)_[A-Za-z0-9]{10}$/)?.[1];
    if (original) {
      ids.add(original);
    }
  }
  return [...ids];
};

export interface GrantHolder {
  id: string;
  rootInternalId: string | null;
}

// holders: other channels of the same platform family that are connected or
// still in their grace period and share an identity, or have none.
export const revokePlan = (
  row: GrantRow,
  hasRevoker: boolean,
  revokeOn: boolean,
  holders: GrantHolder[]
): RevokePlan => {
  if (!hasRevoker) {
    return 'not_supported';
  }
  if (!revokeOn) {
    return 'revoke_off';
  }
  if (!row.rootInternalId || holders.some((holder) => !holder.rootInternalId)) {
    return 'grant_unknown';
  }
  return holders.length ? 'shared_grant' : 'revoke';
};

export interface MediaRefs {
  ids: string[];
  paths: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Media of a post: Post.image is a JSON list of {id, path, thumbnail, …},
// Post.settings can hold more (the thumbnail of a YouTube video). Every object
// with a string id and path counts, at any depth. Unreadable values count as
// none.
export const postMediaRefs = (
  ...values: Array<string | null | undefined>
): MediaRefs => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isObject(value)) {
      return;
    }
    if (typeof value.id === 'string' && typeof value.path === 'string') {
      if (value.id) {
        ids.add(value.id);
      }
      if (value.path) {
        paths.add(value.path);
      }
    }
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };

  for (const raw of values) {
    if (!raw) {
      continue;
    }
    try {
      visit(JSON.parse(raw), 0);
    } catch (err) {
      // Not JSON, nothing to find.
    }
  }
  return { ids: [...ids], paths: [...paths] };
};

export interface StorageLocation {
  prefix: string;
  // Cloudflare keeps every file at the top of the bucket, and removeFile
  // there deletes the last part of the path only (cloudflare.storage.ts). A
  // path with a folder after the prefix would delete another file.
  flat: boolean;
}

// Public prefix of the files Postiz stores (upload.factory.ts): the bucket
// URL on Cloudflare, FRONTEND_URL/uploads locally. Only such files are ever
// removed. Without the variable: none (fail-closed).
export const storageLocation = (
  env: NodeJS.ProcessEnv
): StorageLocation | undefined => {
  const cloudflare = (env.STORAGE_PROVIDER || 'local') === 'cloudflare';
  const base = cloudflare
    ? env.CLOUDFLARE_BUCKET_URL
    : env.FRONTEND_URL && `${env.FRONTEND_URL}/uploads`;
  return base
    ? { prefix: `${base.replace(/\/+$/, '')}/`, flat: cloudflare }
    : undefined;
};

export const inOwnStorage = (
  path: string,
  location: StorageLocation | undefined
) => {
  if (!location || !path.startsWith(location.prefix)) {
    return false;
  }
  const rest = path.slice(location.prefix.length);
  return (
    !!rest && !rest.includes('..') && !(location.flat && rest.includes('/'))
  );
};

export interface MediaCount {
  // In a dry run: would be deleted.
  deleted: number;
  // Used elsewhere, or not a file of our storage.
  kept: number;
  failed: number;
  // Not checked in this run, DELETION_MEDIA_BUDGET_MS was over.
  left: number;
}

export interface DeletionChannel {
  id: string;
  organizationId: string;
  customerId: string | null;
  providerIdentifier: string;
  deletedAt: Date;
}

export interface ChannelDeletionResult {
  integrationId: string;
  providerIdentifier: string;
  mode: 'dry_run' | 'on';
  // deleted: tokens cleared. retry: the next run tries again. planned: dry
  // run. skipped: the channel changed meanwhile.
  status: 'deleted' | 'retry' | 'planned' | 'skipped';
  revoke: RevokePlan | RevokeResult;
  media: MediaCount;
  overdue: boolean;
}

const REVOKE_TEXT: Record<RevokeResult, string> = {
  revoked: 'Zugang bei der Plattform widerrufen',
  already_invalid: 'Zugang war bei der Plattform schon ungültig',
  no_refresh_token: 'kein Widerruf möglich, es liegt kein Refresh-Token vor',
  token_mismatch: 'kein Widerruf, das Token gehört zu einem anderen Konto',
  not_supported: 'kein Widerruf bei dieser Plattform',
  revoke_off: 'kein Widerruf, in dieser Umgebung abgeschaltet',
  shared_grant: 'kein Widerruf, ein anderer Kanal nutzt denselben Zugang',
  grant_unknown: 'kein Widerruf, unklar, wer den Zugang noch nutzt',
  failed: 'Widerruf gescheitert, Frist abgelaufen',
  not_configured: 'Widerruf nicht konfiguriert, Frist abgelaufen',
  changed_meanwhile: 'Kanal wurde während der Löschung geändert',
};

// One event per deletion of a channel. A channel deleted again later has a
// new deletedAt and gets a new id.
export const channelDataDeletedEvent = (
  channel: DeletionChannel,
  revoke: RevokeResult,
  media: MediaCount,
  overdue: boolean,
  now: Date
): HubEvent =>
  createHubEvent({
    kind: 'channel.data_deleted',
    subject: { type: 'channel', id: channel.id },
    stateKey: String(channel.deletedAt.getTime()),
    occurredAt: now,
    postiz: {
      organizationId: channel.organizationId,
      integrationId: channel.id,
      customerId: channel.customerId || null,
      providerIdentifier: channel.providerIdentifier,
    },
    reason: `Getrennter Kanal gelöscht: ${
      REVOKE_TEXT[revoke]
    }, Tokens geleert, ${media.deleted} Medien gelöscht${
      media.kept ? `, ${media.kept} behalten` : ''
    }${
      media.failed || media.left
        ? `, ${media.failed + media.left} nicht gelöscht`
        : ''
    }.`,
    data: {
      deletedAt: channel.deletedAt.toISOString(),
      revoke,
      mediaDeleted: media.deleted,
      mediaKept: media.kept,
      mediaFailed: media.failed,
      mediaLeft: media.left,
      overdue,
    },
  });
