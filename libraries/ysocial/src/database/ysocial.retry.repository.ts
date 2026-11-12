import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Fields "Erneut versuchen" needs to decide (retry.rules.ts). No token, no
// post text.
export const RETRY_POST_FIELDS = {
  id: true,
  organizationId: true,
  state: true,
  deletedAt: true,
  parentPostId: true,
  releaseId: true,
  releaseURL: true,
  error: true,
  integration: {
    select: {
      providerIdentifier: true,
      disabled: true,
      refreshNeeded: true,
      inBetweenSteps: true,
      deletedAt: true,
    },
  },
} as const;

/**
 * "Erneut versuchen" (PLAN 3.3 PR 19): the only write of the ysocial module
 * on Postiz posts. Fixed selects.
 */
@Injectable()
export class YsocialRetryRepository {
  constructor(private _post: PrismaRepository<'post'>) {}

  getPostForRetry(id: string) {
    return this._post.model.post.findUnique({
      where: { id },
      select: RETRY_POST_FIELDS,
    });
  }

  // ERROR -> QUEUE only if the post is still in ERROR. Two clicks at the
  // same time: one gets 1, the other 0 and no workflow start.
  async queueFailedPost(id: string) {
    const { count } = await this._post.model.post.updateMany({
      where: { id, state: 'ERROR', deletedAt: null },
      data: { state: 'QUEUE' },
    });
    return count === 1;
  }
}
