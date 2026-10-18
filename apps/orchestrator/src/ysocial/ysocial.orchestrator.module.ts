import { Module } from '@nestjs/common';
import { YsocialActivities } from './ysocial.activities';
import { YsocialWorkerService } from './ysocial.worker.service';

// Entry point for all ysocial orchestrator code. Imported once in
// apps/orchestrator/src/app.module.ts (patch 2, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial activities can inject the Postiz
// services without further patches.
@Module({
  providers: [YsocialActivities, YsocialWorkerService],
})
export class YsocialOrchestratorModule {}
