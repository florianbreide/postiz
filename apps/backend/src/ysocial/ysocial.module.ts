import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { YsocialStatusController } from './ysocial.status.controller';
import { YsocialReadController } from './ysocial.read.controller';
import { YsocialRetryController } from './ysocial.retry.controller';
import { YsocialTestController } from './ysocial.test.controller';
import { YsocialInboxController } from './ysocial.inbox.controller';
import { YsocialMetaWebhookController } from './ysocial.meta.webhook.controller';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialTestRoutesGuard } from './ysocial.test.routes.guard';
import { YsocialInboxDemoGuard } from './ysocial.inbox.demo.guard';
import { YsocialInboxGuard } from './ysocial.inbox.guard';
import { YsocialInboxEventsGuard } from './ysocial.inbox.events.guard';
import { YsocialMetaWebhookGuard } from './ysocial.meta.webhook.guard';
import { YsocialStatusService } from './ysocial.status.service';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryService } from '../../../../libraries/ysocial/src/retry/ysocial.retry.service';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialTestSwitchService } from '../../../../libraries/ysocial/src/health/ysocial.test.switch.service';
import { YsocialInboxService } from '../../../../libraries/ysocial/src/inbox/ysocial.inbox.service';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialMetaWebhookService } from '../../../../libraries/ysocial/src/webhooks/ysocial.meta.webhook.service';
import { YsocialWebhookRepository } from '../../../../libraries/ysocial/src/database/ysocial.webhook.repository';
import { ysocialTokenKeyCheckProvider } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialAutomationMiddleware } from './ysocial.automation.middleware';
import { YsocialAutomationCheck } from '../../../../libraries/ysocial/src/automation/ysocial.automation.check';
import { YsocialAutomationRepository } from '../../../../libraries/ysocial/src/database/ysocial.automation.repository';

// Entry point for all ysocial backend code. Imported once in
// apps/backend/src/app.module.ts (patch 1, see YSOCIAL-PATCHES.md).
// DatabaseModule is global, so ysocial services can inject the Postiz
// services and repositories without further patches.
// The token key check stops the start without the right key (PR 25).
// The automation middleware refuses repeats and plugs on the Postiz routes
// below (D15, Rule 2), the automation check counts what was set before.
@Module({
  controllers: [
    YsocialStatusController,
    YsocialReadController,
    YsocialRetryController,
    YsocialTestController,
    YsocialInboxController,
    YsocialMetaWebhookController,
  ],
  providers: [
    ysocialTokenKeyCheckProvider,
    YsocialTokenGuard,
    YsocialTestRoutesGuard,
    YsocialInboxDemoGuard,
    YsocialInboxGuard,
    YsocialInboxEventsGuard,
    YsocialMetaWebhookGuard,
    YsocialStatusService,
    YsocialReadService,
    YsocialReadRepository,
    YsocialRetryService,
    YsocialRetryRepository,
    YsocialTestSwitchService,
    YsocialInboxService,
    YsocialInboxRepository,
    YsocialMetaWebhookService,
    YsocialWebhookRepository,
    YsocialAutomationCheck,
    YsocialAutomationRepository,
  ],
})
export class YsocialModule implements NestModule {
  // The Postiz routes that set a repeat or a plug (posts.controller.ts,
  // public.integrations.controller.ts, integrations.controller.ts). A test
  // reads them from the Postiz sources, so a rename upstream shows up.
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(YsocialAutomationMiddleware)
      .forRoutes(
        { path: 'posts', method: RequestMethod.POST },
        { path: 'public/v1/posts', method: RequestMethod.POST },
        { path: 'public/v1/posts/:id/settings', method: RequestMethod.PUT },
        { path: 'integrations/:id/plugs', method: RequestMethod.POST },
        { path: 'integrations/plugs/:id/activate', method: RequestMethod.PUT }
      );
  }
}
