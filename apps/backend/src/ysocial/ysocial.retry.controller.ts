import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialRetryService } from '../../../../libraries/ysocial/src/retry/ysocial.retry.service';
import { YsocialRetryDto } from '../../../../libraries/ysocial/src/dtos/ysocial.retry.dto';
import { YSOCIAL_ACTOR_HEADER } from '../../../../libraries/ysocial/src/retry/retry.rules';

// "Erneut versuchen" for the hub (PLAN 3.3 PR 19). Internal like
// /ysocial/status: the reverse proxy blocks /api/ysocial/* from outside.
@ApiExcludeController()
@UseGuards(YsocialTokenGuard)
@Controller('/ysocial')
export class YsocialRetryController {
  constructor(private _retryService: YsocialRetryService) {}

  // 202: the post is in QUEUE, the Postiz workflow publishes it.
  @Post('/posts/:id/retry')
  @HttpCode(202)
  retry(
    @Param('id') id: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialRetryDto
  ) {
    return this._retryService.retry(id, actor, body?.confirmUnclear === true);
  }
}
