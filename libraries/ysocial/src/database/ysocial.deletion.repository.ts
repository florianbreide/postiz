import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Fields of a channel for the deletion job. The tokens never leave
// YsocialChannelDeletionService.
export const DELETION_CHANNEL_FIELDS = {
  id: true,
  organizationId: true,
  customerId: true,
  internalId: true,
  rootInternalId: true,
  providerIdentifier: true,
  deletedAt: true,
  updatedAt: true,
  token: true,
  refreshToken: true,
} as const;

export const DELETION_MEDIA_FIELDS = {
  id: true,
  path: true,
  thumbnail: true,
  _count: { select: { userPicture: true, agencies: true, oauthApps: true } },
} as const;

export interface DeletionMediaRow {
  id: string;
  path: string;
  thumbnail: string | null;
}

/**
 * Database access of the deletion job (Datenschutz D1), fixed field lists.
 *
 * It writes only to rows the job has checked: the tokens of a deleted
 * channel, under the condition that deletedAt and updatedAt are still what
 * the job read, and Media rows of the channel's organization that nothing
 * else uses (YsocialChannelDeletionService).
 */
@Injectable()
export class YsocialDeletionRepository {
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _media: PrismaRepository<'media'>,
    private _sets: PrismaRepository<'sets'>,
    private _signatures: PrismaRepository<'signatures'>,
    private _clippingClip: PrismaRepository<'clippingClip'>
  ) {}

  // Deleted before the cutoff. The service picks those that still hold a
  // token.
  getDeletedChannels(before: Date) {
    return this._integration.model.integration.findMany({
      where: { deletedAt: { not: null, lte: before } },
      select: { id: true, deletedAt: true, token: true, refreshToken: true },
      orderBy: { deletedAt: 'asc' },
    });
  }

  getChannelForDeletion(id: string) {
    return this._integration.model.integration.findUnique({
      where: { id },
      select: DELETION_CHANNEL_FIELDS,
    });
  }

  // Other channels of the providers that are connected, or deleted after the
  // cutoff (still in their grace period), and share an identity of the
  // channel or have no rootInternalId. Over all organizations.
  getGrantHolders(params: {
    id: string;
    providers: string[];
    identities: string[];
    graceCutoff: Date;
  }) {
    return this._integration.model.integration.findMany({
      where: {
        id: { not: params.id },
        providerIdentifier: { in: params.providers },
        AND: [
          {
            OR: [
              { deletedAt: null },
              { deletedAt: { gt: params.graceCutoff } },
            ],
          },
          {
            OR: [
              { rootInternalId: null },
              { rootInternalId: { in: params.identities } },
              { internalId: { in: params.identities } },
            ],
          },
        ],
      },
      select: { id: true, rootInternalId: true },
      take: 10,
    });
  }

  // Still deleted and unchanged since the job read it. Connecting it again,
  // a token refresh or any other write of Postiz changes updatedAt.
  async isUnchanged(row: {
    id: string;
    deletedAt: Date;
    updatedAt: Date | null;
  }) {
    const count = await this._integration.model.integration.count({
      where: { id: row.id, deletedAt: row.deletedAt, updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  // token is required in Postiz, so it becomes an empty string. 0: the row
  // changed meanwhile, nothing written.
  async clearTokens(row: {
    id: string;
    deletedAt: Date;
    updatedAt: Date | null;
  }) {
    const { count } = await this._integration.model.integration.updateMany({
      where: { id: row.id, deletedAt: row.deletedAt, updatedAt: row.updatedAt },
      data: { token: '', refreshToken: null },
    });
    return count;
  }

  // Media fields of every post of the channel, deleted ones included.
  getPostMedia(integrationId: string) {
    return this._post.model.post.findMany({
      where: { integrationId },
      select: { image: true, settings: true },
    });
  }

  getMedia(organizationId: string, ids: string[], paths: string[]) {
    return this._media.model.media.findMany({
      where: {
        organizationId,
        OR: [{ id: { in: ids } }, { path: { in: paths } }],
      },
      select: DELETION_MEDIA_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  // Is the medium or its file used anywhere else: another Media row with the
  // same file, a post that is not deleted (any channel, any organization), a
  // set, a signature or a clip. User pictures, agency logos and OAuth apps
  // come with getMedia (_count).
  async mediaInUse(media: DeletionMediaRow) {
    const files = [media.path, media.thumbnail].filter(
      (value): value is string => !!value
    );
    const refs = [media.id, ...files];
    const [otherMedia, post, set, signature, clip] = await Promise.all([
      this._media.model.media.count({
        where: {
          id: { not: media.id },
          OR: files.flatMap((file) => [{ path: file }, { thumbnail: file }]),
        },
      }),
      this._post.model.post.findFirst({
        where: {
          deletedAt: null,
          OR: refs.flatMap((ref) => [
            { image: { contains: ref } },
            { settings: { contains: ref } },
            { content: { contains: ref } },
          ]),
        },
        select: { id: true },
      }),
      this._sets.model.sets.findFirst({
        where: { OR: refs.map((ref) => ({ content: { contains: ref } })) },
        select: { id: true },
      }),
      this._signatures.model.signatures.findFirst({
        where: {
          deletedAt: null,
          OR: refs.map((ref) => ({ content: { contains: ref } })),
        },
        select: { id: true },
      }),
      this._clippingClip.model.clippingClip.findFirst({
        where: {
          OR: [
            { mediaId: media.id },
            ...files.flatMap((file) => [{ path: file }, { thumbnail: file }]),
          ],
        },
        select: { id: true },
      }),
    ]);
    return !!(otherMedia || post || set || signature || clip);
  }

  async deleteMedia(id: string, organizationId: string) {
    const { count } = await this._media.model.media.deleteMany({
      where: { id, organizationId },
    });
    return count;
  }
}
