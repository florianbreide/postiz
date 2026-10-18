import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Read-only access of the ysocial module to Postiz posts. Every query has a
 * fixed select. Only getPostForPlatformCheck reads the channel token, and
 * its result never leaves YsocialPostVerificationService.
 */
@Injectable()
export class YsocialPostRepository {
  constructor(private _post: PrismaRepository<'post'>) {}

  // First posts of a thread with a date in the window, without drafts and
  // deleted posts (PLAN 3.3 PR 17).
  findPostsToVerify(from: Date, to: Date) {
    return this._post.model.post.findMany({
      where: {
        publishDate: { gte: from, lte: to },
        deletedAt: null,
        parentPostId: null,
        state: { in: ['QUEUE', 'PUBLISHED', 'ERROR'] },
      },
      select: { id: true },
      orderBy: { publishDate: 'asc' },
      take: 500,
    });
  }

  getPostForVerification(id: string) {
    return this._post.model.post.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        state: true,
        publishDate: true,
        deletedAt: true,
        releaseURL: true,
        error: true,
        integration: {
          select: {
            providerIdentifier: true,
            customerId: true,
            disabled: true,
            refreshNeeded: true,
            inBetweenSteps: true,
            deletedAt: true,
          },
        },
      },
    });
  }

  getPostForPlatformCheck(id: string) {
    return this._post.model.post.findUnique({
      where: { id },
      select: {
        id: true,
        state: true,
        releaseId: true,
        settings: true,
        integration: {
          select: {
            providerIdentifier: true,
            internalId: true,
            token: true,
            tokenExpiration: true,
            disabled: true,
            refreshNeeded: true,
            inBetweenSteps: true,
            deletedAt: true,
          },
        },
      },
    });
  }
}
