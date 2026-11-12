import { Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialTestRoutesGuard } from './ysocial.test.routes.guard';
import { YsocialTestSwitchService } from '../../../../libraries/ysocial/src/health/ysocial.test.switch.service';

// Test switch for the channel check (PLAN 3.3 PR 19, E23), only on staging.
// The guards run in this order: without YSOCIAL_TEST_ROUTES=true the route
// does not exist (404), then the service token.
@ApiExcludeController()
@UseGuards(YsocialTestRoutesGuard, YsocialTokenGuard)
@Controller('/ysocial/test')
export class YsocialTestController {
  constructor(private _testSwitchService: YsocialTestSwitchService) {}

  // For 30 minutes the channel check sends an invalid token for this channel.
  @Post('/integrations/:id/invalid-token')
  setInvalidToken(@Param('id') id: string) {
    return this._testSwitchService.setInvalidToken(id);
  }

  @Delete('/integrations/:id/invalid-token')
  clearInvalidToken(@Param('id') id: string) {
    return this._testSwitchService.clearInvalidToken(id);
  }
}
