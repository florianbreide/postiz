import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { YsocialInboxEventsGuard } from './ysocial.inbox.events.guard';
import { YsocialMetaWebhookGuard } from './ysocial.meta.webhook.guard';
import { YsocialMetaWebhookService } from '../../../../libraries/ysocial/src/webhooks/ysocial.meta.webhook.service';

// Receiver of the Meta webhooks (PR B, for every Meta channel since Phase 3
// PR 74). The only ysocial route Meta reaches from outside: outside
// /ysocial, which the reverse proxy blocks (/api/ysocial/*), and without
// /auth, which the PoliciesGuard of Postiz skips. From outside:
// /api/ysocial-meta-webhook. The guards run in this order: without
// YSOCIAL_INBOX_EVENTS=true the route does not exist (404), then the verify
// token (GET) or the signature (POST).
@ApiExcludeController()
@UseGuards(YsocialInboxEventsGuard, YsocialMetaWebhookGuard)
@Controller('/ysocial-meta-webhook')
export class YsocialMetaWebhookController {
  constructor(private _webhookService: YsocialMetaWebhookService) {}

  // Verification request: the guard checked token and challenge.
  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  verify(@Query('hub.challenge') challenge: string) {
    return challenge;
  }

  @Post()
  @HttpCode(200)
  receive(@Body() body: unknown) {
    return this._webhookService.record(body);
  }
}
