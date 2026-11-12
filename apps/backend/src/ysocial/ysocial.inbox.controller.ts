import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialInboxDemoGuard } from './ysocial.inbox.demo.guard';
import { YsocialInboxService } from '../../../../libraries/ysocial/src/inbox/ysocial.inbox.service';
import {
  YsocialInboxDeleteDto,
  YsocialInboxHideDto,
  YsocialInboxReplyDto,
} from '../../../../libraries/ysocial/src/dtos/ysocial.inbox.dto';
import { YSOCIAL_ACTOR_HEADER } from '../../../../libraries/ysocial/src/retry/retry.rules';

// Inbox demo for the Meta screencasts (PLAN 3.3 PR 26, E25), only on
// staging. Internal like /ysocial/status: the reverse proxy blocks
// /api/ysocial/* from outside. The guards run in this order: without
// YSOCIAL_DEMO_INTEGRATIONS the routes do not exist (404), then the
// service token. Writes need X-Ysocial-Actor like the retry route.
@ApiExcludeController()
@UseGuards(YsocialInboxDemoGuard, YsocialTokenGuard)
@Controller('/ysocial/inbox')
export class YsocialInboxController {
  constructor(private _inboxService: YsocialInboxService) {}

  @Get('/integrations/:id/comments')
  getComments(@Param('id') id: string) {
    return this._inboxService.getComments(id);
  }

  @Post('/integrations/:id/comments/:commentId/replies')
  reply(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxReplyDto
  ) {
    return this._inboxService.reply(id, commentId, actor, body.message);
  }

  @Post('/integrations/:id/comments/:commentId/hide')
  @HttpCode(200)
  hide(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxHideDto
  ) {
    return this._inboxService.hide(id, commentId, actor, body.hide);
  }

  // Delete only with {"confirmDelete": true}, otherwise 409.
  @Delete('/integrations/:id/comments/:commentId')
  remove(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxDeleteDto
  ) {
    return this._inboxService.remove(
      id,
      commentId,
      actor,
      body?.confirmDelete === true
    );
  }
}
