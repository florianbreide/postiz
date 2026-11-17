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
import { YsocialInboxDemoGuard } from './ysocial.inbox.demo.guard';
import { YsocialMetaWebhookGuard } from './ysocial.meta.webhook.guard';
import { YsocialMetaWebhookService } from '../../../../libraries/ysocial/src/webhooks/ysocial.meta.webhook.service';

// Receiver of the Meta webhooks for the inbox demo (PR B), only on staging.
// The only ysocial route Meta reaches from outside: outside /ysocial, which
// the reverse proxy blocks (/api/ysocial/*), and without /auth, which the
// PoliciesGuard of Postiz skips. From outside: /api/ysocial-meta-webhook.
// The guards run in this order: without YSOCIAL_DEMO_INTEGRATIONS the route
// does not exist (404), then the verify token (GET) or the signature (POST).
@ApiExcludeController()
@UseGuards(YsocialInboxDemoGuard, YsocialMetaWebhookGuard)
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
