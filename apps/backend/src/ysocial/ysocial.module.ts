import { Module } from '@nestjs/common';
import { YsocialStatusController } from './ysocial.status.controller';
import { YsocialTokenGuard } from './ysocial.token.guard';

// Entry point for all ysocial backend code. Imported once in
// apps/backend/src/app.module.ts (patch 1, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so later ysocial services can inject the
// Postiz services without further patches.
@Module({
  controllers: [YsocialStatusController],
  providers: [YsocialTokenGuard],
})
export class YsocialModule {}
