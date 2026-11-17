import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialTokenGuard } from './ysocial.token.guard';
import {
  InboxDemoOnly,
  InboxWebhooksRoute,
  YsocialInboxGuard,
} from './ysocial.inbox.guard';
import { YsocialInboxDemoGuard } from './ysocial.inbox.demo.guard';
import { YsocialInboxService } from '../../../../libraries/ysocial/src/inbox/ysocial.inbox.service';
import {
  YsocialInboxCommentQueryDto,
  YsocialInboxDeleteDto,
  YsocialInboxHideDto,
  YsocialInboxItemsQueryDto,
  YsocialInboxReplyDto,
} from '../../../../libraries/ysocial/src/dtos/ysocial.inbox.dto';
import { YSOCIAL_ACTOR_HEADER } from '../../../../libraries/ysocial/src/retry/retry.rules';
import { YsocialMetaWebhookService } from '../../../../libraries/ysocial/src/webhooks/ysocial.meta.webhook.service';

// Inbox routes: the demo for the Meta screencasts (PLAN 3.3 PR 26, E25,
// only on staging) and, with YSOCIAL_INBOX_ENABLED=true, the inbox of the hub
// for every Facebook and Instagram channel (Phase 3 PR 73). Internal like
// /ysocial/status: the reverse proxy blocks /api/ysocial/* from outside. The
// guards run in this order: without the demo list and the switch the routes
// do not exist (404), then the service token. Writes need X-Ysocial-Actor
// like the retry route. The routes for the webhooks of a channel exist with
// the demo list or YSOCIAL_INBOX_EVENTS=true (InboxWebhooksRoute, PR 74),
// the log of the events with the demo list only (InboxDemoOnly), both 404
// before the token. The routes of one comment take ?postId=
// (YsocialInboxCommentQueryDto).
@ApiExcludeController()
@UseGuards(YsocialInboxGuard, YsocialTokenGuard)
@Controller('/ysocial/inbox')
export class YsocialInboxController {
  constructor(
    private _inboxService: YsocialInboxService,
    private _webhookService: YsocialMetaWebhookService
  ) {}

  @Get('/integrations/:id/comments')
  getComments(@Param('id') id: string) {
    return this._inboxService.getComments(id);
  }

  // What the platform of the channel allows: reply, hide, delete, like,
  // realtime (PR 73).
  @Get('/integrations/:id/capabilities')
  getCapabilities(@Param('id') id: string) {
    return this._inboxService.getCapabilities(id);
  }

  // Comments and replies of the posts in the window, since a time, in pages
  // (PR 73, E82).
  @Get('/integrations/:id/items')
  getItems(@Param('id') id: string, @Query() query: YsocialInboxItemsQueryDto) {
    return this._inboxService.getItems(id, query);
  }

  // One comment with its conversation, for the webhook bell and reloading.
  @Get('/integrations/:id/comments/:commentId')
  getComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.getComment(id, commentId, query.postId);
  }

  // Like as the Page, only where the platform allows it (Facebook).
  @Post('/integrations/:id/comments/:commentId/like')
  @HttpCode(200)
  like(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.like(id, commentId, actor, true, query.postId);
  }

  @Delete('/integrations/:id/comments/:commentId/like')
  unlike(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.like(id, commentId, actor, false, query.postId);
  }

  @Post('/integrations/:id/comments/:commentId/replies')
  reply(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxReplyDto,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.reply(
      id,
      commentId,
      actor,
      body.message,
      query.postId
    );
  }

  @Post('/integrations/:id/comments/:commentId/hide')
  @HttpCode(200)
  hide(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxHideDto,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.hide(
      id,
      commentId,
      actor,
      body.hide,
      query.postId
    );
  }

  // Delete only with {"confirmDelete": true}, otherwise 409.
  @Delete('/integrations/:id/comments/:commentId')
  remove(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined,
    @Body() body: YsocialInboxDeleteDto,
    @Query() query: YsocialInboxCommentQueryDto
  ) {
    return this._inboxService.remove(
      id,
      commentId,
      actor,
      body?.confirmDelete === true,
      query.postId
    );
  }

  // Is our app on the Page of the channel (PR B)? With the demo list, for
  // every channel with YSOCIAL_INBOX_EVENTS=true (PR 74).
  @Get('/integrations/:id/webhooks')
  @InboxWebhooksRoute()
  getWebhooks(@Param('id') id: string) {
    return this._inboxService.getWebhooks(id);
  }

  // Puts our app on the Page with the field feed. A write at Meta, so
  // X-Ysocial-Actor like the other writes. The hub lets only an admin
  // trigger it (E97).
  @Post('/integrations/:id/webhooks')
  @InboxWebhooksRoute()
  @HttpCode(200)
  subscribeWebhooks(
    @Param('id') id: string,
    @Headers(YSOCIAL_ACTOR_HEADER) actor: string | undefined
  ) {
    return this._inboxService.subscribeWebhooks(id, actor);
  }

  // The latest events the receiver logged, newest first. Ids, field, kind
  // and time, no text and no names.
  @Get('/webhooks/events')
  @InboxDemoOnly()
  @UseGuards(YsocialInboxDemoGuard)
  getWebhookEvents() {
    return this._webhookService.events();
  }
}
