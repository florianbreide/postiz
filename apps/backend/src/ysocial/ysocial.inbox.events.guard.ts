import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { inboxEventsEnabled } from '../../../../libraries/ysocial/src/webhooks/webhook.rules';

/**
 * The receiver of the Meta webhooks exists only with
 * YSOCIAL_INBOX_EVENTS=true (Phase 3 PR 74, until 0.9.7 with the demo list).
 * Without it the answer is the same 404 as for any unknown route, before the
 * verify token and the signature (YsocialMetaWebhookGuard), like
 * YsocialInboxDemoGuard.
 */
@Injectable()
export class YsocialInboxEventsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (inboxEventsEnabled(process.env)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Same text as the not-found handler of Nest.
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl}`
    );
  }
}
