import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Read-only counts for the start check of automatic posts (D15,
 * YsocialAutomationCheck), one per thread (parentPostId null, Postiz writes
 * both fields into every row of it): repeating posts, posts whose settings may hold an
 * internal plug, active global plugs. Only settings leaves this repository,
 * and only for the check, never a text or a token.
 */
@Injectable()
export class YsocialAutomationRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>
  ) {}

  countRepeatingPosts() {
    return this._post.model.post.count({
      where: { deletedAt: null, parentPostId: null, intervalInDays: { gt: 0 } },
    });
  }

  // Candidates only: the service checks the settings itself.
  getPlugSettings() {
    return this._post.model.post.findMany({
      where: {
        deletedAt: null,
        parentPostId: null,
        settings: { contains: 'plug-' },
      },
      select: { settings: true },
    });
  }

  countActiveGlobalPlugs() {
    return this._plugs.model.plugs.count({
      where: { activated: true, integration: { deletedAt: null } },
    });
  }
}
