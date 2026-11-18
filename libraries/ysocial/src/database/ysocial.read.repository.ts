import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Fixed field lists of the read API for the hub (PLAN 3.3 PR 18). Never
 * token, refreshToken or customInstanceDetails, and settings never goes out:
 * the post queries read it (POST_QUERY_FIELDS) only for the field plug. Post
 * text and media since PR 36 (E52): the service passes on only path and type
 * of each medium, see ysocial.read.service.ts, and since 0.10.1 its size
 * from the media library (MEDIA_FIELDS, K6).
 */
export const CUSTOMER_FIELDS = {
  id: true,
  orgId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const INTEGRATION_FIELDS = {
  id: true,
  organizationId: true,
  customerId: true,
  name: true,
  customName: true,
  picture: true,
  profile: true,
  providerIdentifier: true,
  type: true,
  disabled: true,
  refreshNeeded: true,
  inBetweenSteps: true,
  tokenExpiration: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const POST_FIELDS = {
  id: true,
  organizationId: true,
  integrationId: true,
  group: true,
  parentPostId: true,
  state: true,
  publishDate: true,
  // Repeat interval in days, null for a single post. Tells the hub when
  // "Erneut versuchen" answers interval_reanchor (PR 37).
  intervalInDays: true,
  content: true,
  image: true,
  releaseURL: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} as const;

// What the queries of posts read: POST_FIELDS and settings. settings only
// tells YsocialReadService whether the post has a plug (field plug, PR 52 of
// the hub, D15), it never goes out (READ_API_FORBIDDEN_FIELDS).
export const POST_QUERY_FIELDS = { ...POST_FIELDS, settings: true } as const;

export const READ_API_FORBIDDEN_FIELDS = [
  'token',
  'refreshToken',
  'customInstanceDetails',
  'settings',
  'additionalSettings',
  'internalId',
];

export const POSTS_LIMIT = 2000;

// What the size of a medium needs from the media library (K6): only these.
export const MEDIA_FIELDS = {
  id: true,
  organizationId: true,
  path: true,
  fileSize: true,
} as const;

@Injectable()
export class YsocialReadRepository {
  constructor(
    private _customer: PrismaRepository<'customer'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _media: PrismaRepository<'media'>
  ) {}

  getCustomers() {
    return this._customer.model.customer.findMany({
      where: { deletedAt: null },
      select: CUSTOMER_FIELDS,
      orderBy: { name: 'asc' },
    });
  }

  getIntegrations() {
    return this._integration.model.integration.findMany({
      where: { deletedAt: null },
      select: INTEGRATION_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  getPosts(from: Date, to: Date) {
    return this._post.model.post.findMany({
      where: { deletedAt: null, publishDate: { gte: from, lt: to } },
      select: POST_QUERY_FIELDS,
      orderBy: { publishDate: 'asc' },
      take: POSTS_LIMIT,
    });
  }

  getPost(id: string) {
    return this._post.model.post.findFirst({
      where: { id, deletedAt: null },
      select: POST_QUERY_FIELDS,
    });
  }

  // The media rows of the ids in the posts, also deleted ones: a post keeps
  // its medium after it left the library. The service checks organization
  // and path.
  getMedia(ids: string[]) {
    return this._media.model.media.findMany({
      where: { id: { in: ids } },
      select: MEDIA_FIELDS,
    });
  }

  // A post and its comments share one group per channel
  // (PostsRepository.createOrUpdatePost). The service puts them in order.
  getPostGroup(organizationId: string, group: string) {
    return this._post.model.post.findMany({
      where: { organizationId, group, deletedAt: null },
      select: POST_QUERY_FIELDS,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
