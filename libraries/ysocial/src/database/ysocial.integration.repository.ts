import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Fields of a channel for the checks. No token.
export const CHANNEL_HEALTH_FIELDS = {
  id: true,
  organizationId: true,
  customerId: true,
  name: true,
  providerIdentifier: true,
  disabled: true,
  refreshNeeded: true,
  inBetweenSteps: true,
  tokenExpiration: true,
  updatedAt: true,
} as const;

/**
 * Read-only access of the ysocial module to Postiz channels (Integration).
 * Every query has a fixed select. Only getChannelForPlatformCheck reads the
 * token, its result never leaves YsocialChannelHealthService.
 */
@Injectable()
export class YsocialIntegrationRepository {
  constructor(private _integration: PrismaRepository<'integration'>) {}

  getChannels() {
    return this._integration.model.integration.findMany({
      where: { deletedAt: null },
      select: CHANNEL_HEALTH_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  getChannelForPlatformCheck(id: string) {
    return this._integration.model.integration.findUnique({
      where: { id },
      select: {
        id: true,
        providerIdentifier: true,
        internalId: true,
        token: true,
      },
    });
  }
}
