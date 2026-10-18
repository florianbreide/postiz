import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialStatusService } from './ysocial.status.service';
import { YSOCIAL_MODULE_VERSION } from '../../../../libraries/ysocial/src/ysocial.version';

// Internal route for the hub and for health checks. Never expose it publicly:
// the reverse proxy blocks /api/ysocial/* from outside.
@ApiExcludeController()
@UseGuards(YsocialTokenGuard)
@Controller('/ysocial')
export class YsocialStatusController {
  constructor(private _statusService: YsocialStatusService) {}

  // Postiz runs without the ysocial worker, so the route stays 200 and
  // reports "Worker aus" with the reason.
  @Get('/status')
  async getStatus() {
    return {
      ok: true,
      module: 'ysocial',
      version: YSOCIAL_MODULE_VERSION,
      worker: await this._statusService.getWorkerStatus(),
    };
  }
}
