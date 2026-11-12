import { Module } from '@nestjs/common';
import { YsocialActivities } from './ysocial.activities';
import { YsocialWorkerService } from './ysocial.worker.service';
import { YsocialTemporalClient } from './ysocial.temporal.client';
import { YsocialPostRepository } from '../../../../libraries/ysocial/src/database/ysocial.post.repository';
import { YsocialPostVerificationService } from '../../../../libraries/ysocial/src/verification/ysocial.post.verification.service';
import { YsocialIntegrationRepository } from '../../../../libraries/ysocial/src/database/ysocial.integration.repository';
import { YsocialChannelHealthService } from '../../../../libraries/ysocial/src/health/ysocial.channel.health.service';
import { ysocialTokenKeyCheckProvider } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialTokenMigrationService } from '../../../../libraries/ysocial/src/tokens/ysocial.token.migration.service';

// Entry point for all ysocial orchestrator code. Imported once in
// apps/orchestrator/src/app.module.ts (patch 2, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial activities can inject the Postiz
// services without further patches.
// The token key check stops the start without the right key (PR 25), unlike
// the worker, which never stops the orchestrator.
@Module({
  providers: [
    ysocialTokenKeyCheckProvider,
    YsocialPostRepository,
    YsocialPostVerificationService,
    YsocialIntegrationRepository,
    YsocialChannelHealthService,
    YsocialTokenMigrationService,
    YsocialTemporalClient,
    YsocialActivities,
    YsocialWorkerService,
  ],
})
export class YsocialOrchestratorModule {}
