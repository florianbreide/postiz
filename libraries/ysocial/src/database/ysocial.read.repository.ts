import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Fixed field lists of the read API for the hub (PLAN 3.3 PR 18). Never
 * token, refreshToken, customInstanceDetails or settings. No post text and
 * no media either: the hub does not need them before PR 23, and adding them
 * is a decision of its own.
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
  releaseURL: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const READ_API_FORBIDDEN_FIELDS = [
  'token',
  'refreshToken',
  'customInstanceDetails',
  'settings',
  'content',
  'image',
  'additionalSettings',
  'internalId',
];

export const POSTS_LIMIT = 2000;

@Injectable()
export class YsocialReadRepository {
  constructor(
    private _customer: PrismaRepository<'customer'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>
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
      select: POST_FIELDS,
      orderBy: { publishDate: 'asc' },
      take: POSTS_LIMIT,
    });
  }
}
