import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Fields the inbox demo needs from a channel (PLAN 3.3 PR 26). The token
// comes decrypted from Prisma (patch 3) and never leaves
// YsocialInboxService and the inbox provider.
export const INBOX_CHANNEL_FIELDS = {
  id: true,
  providerIdentifier: true,
  internalId: true,
  token: true,
  disabled: true,
  refreshNeeded: true,
  inBetweenSteps: true,
  deletedAt: true,
} as const;

/**
 * Read-only access of the inbox demo to Postiz channels. Comments are never
 * stored: no write, no table.
 */
@Injectable()
export class YsocialInboxRepository {
  constructor(private _integration: PrismaRepository<'integration'>) {}

  getChannelForInbox(id: string) {
    return this._integration.model.integration.findUnique({
      where: { id },
      select: INBOX_CHANNEL_FIELDS,
    });
  }
}
