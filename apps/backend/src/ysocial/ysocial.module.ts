import { Module } from '@nestjs/common';
import { YsocialStatusController } from './ysocial.status.controller';
import { YsocialReadController } from './ysocial.read.controller';
import { YsocialRetryController } from './ysocial.retry.controller';
import { YsocialTestController } from './ysocial.test.controller';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialTestRoutesGuard } from './ysocial.test.routes.guard';
import { YsocialStatusService } from './ysocial.status.service';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryService } from '../../../../libraries/ysocial/src/retry/ysocial.retry.service';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialTestSwitchService } from '../../../../libraries/ysocial/src/health/ysocial.test.switch.service';
import { ysocialTokenKeyCheckProvider } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';

// Entry point for all ysocial backend code. Imported once in
// apps/backend/src/app.module.ts (patch 1, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial services can inject the Postiz
// services and repositories without further patches.
// The token key check stops the start without the right key (PR 25).
@Module({
  controllers: [
    YsocialStatusController,
    YsocialReadController,
    YsocialRetryController,
    YsocialTestController,
  ],
  providers: [
    ysocialTokenKeyCheckProvider,
    YsocialTokenGuard,
    YsocialTestRoutesGuard,
    YsocialStatusService,
    YsocialReadService,
    YsocialReadRepository,
    YsocialRetryService,
    YsocialRetryRepository,
    YsocialTestSwitchService,
  ],
})
export class YsocialModule {}
