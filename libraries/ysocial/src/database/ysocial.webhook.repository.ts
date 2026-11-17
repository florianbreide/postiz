import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// What the bell of a webhook needs from a channel. No token.
export const WEBHOOK_CHANNEL_FIELDS = {
  id: true,
  organizationId: true,
  customerId: true,
  providerIdentifier: true,
} as const;

// More channels of one Page than this would be a fault, not a customer.
const WEBHOOK_CHANNELS_LIMIT = 20;

/**
 * Read-only access of the Meta webhook receiver to Postiz channels (Phase 3,
 * PR 74): which channels belong to the Page or Instagram account of an
 * event. Over all organizations, without deleted or disabled ones.
 */
@Injectable()
export class YsocialWebhookRepository {
  constructor(private _integration: PrismaRepository<'integration'>) {}

  getChannelsForWebhook(providerIdentifier: string, internalId: string) {
    return this._integration.model.integration.findMany({
      where: {
        providerIdentifier,
        internalId,
        deletedAt: null,
        disabled: false,
      },
      select: WEBHOOK_CHANNEL_FIELDS,
      orderBy: { createdAt: 'asc' },
      take: WEBHOOK_CHANNELS_LIMIT,
    });
  }
}
