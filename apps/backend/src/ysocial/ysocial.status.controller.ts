import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YSOCIAL_MODULE_VERSION } from '../../../../libraries/ysocial/src/ysocial.version';

// Internal route for the hub and for health checks. Never expose it publicly:
// the reverse proxy blocks /api/ysocial/* from outside.
@ApiExcludeController()
@UseGuards(YsocialTokenGuard)
@Controller('/ysocial')
export class YsocialStatusController {
  @Get('/status')
  getStatus() {
    return {
      ok: true,
      module: 'ysocial',
      version: YSOCIAL_MODULE_VERSION,
    };
  }
}
