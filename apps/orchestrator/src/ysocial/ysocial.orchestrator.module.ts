import { Module } from '@nestjs/common';
import { YsocialActivities } from './ysocial.activities';
import { YsocialWorkerService } from './ysocial.worker.service';
import { YsocialTemporalClient } from './ysocial.temporal.client';
import { YsocialPostRepository } from '../../../../libraries/ysocial/src/database/ysocial.post.repository';
import { YsocialPostVerificationService } from '../../../../libraries/ysocial/src/verification/ysocial.post.verification.service';
import { YsocialIntegrationRepository } from '../../../../libraries/ysocial/src/database/ysocial.integration.repository';
import { YsocialChannelHealthService } from '../../../../libraries/ysocial/src/health/ysocial.channel.health.service';

// Entry point for all ysocial orchestrator code. Imported once in
// apps/orchestrator/src/app.module.ts (patch 2, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial activities can inject the Postiz
// services without further patches.
@Module({
  providers: [
    YsocialPostRepository,
    YsocialPostVerificationService,
    YsocialIntegrationRepository,
    YsocialChannelHealthService,
    YsocialTemporalClient,
    YsocialActivities,
    YsocialWorkerService,
  ],
})
export class YsocialOrchestratorModule {}
