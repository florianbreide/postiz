import { Module } from '@nestjs/common';
import { YsocialStatusController } from './ysocial.status.controller';
import { YsocialReadController } from './ysocial.read.controller';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialStatusService } from './ysocial.status.service';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';

// Entry point for all ysocial backend code. Imported once in
// apps/backend/src/app.module.ts (patch 1, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial services can inject the Postiz
// services and repositories without further patches.
@Module({
  controllers: [YsocialStatusController, YsocialReadController],
  providers: [
    YsocialTokenGuard,
    YsocialStatusService,
    YsocialReadService,
    YsocialReadRepository,
  ],
})
export class YsocialModule {}
