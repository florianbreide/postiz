import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { inboxDemoEnabled } from '../../../../libraries/ysocial/src/inbox/inbox.rules';

/**
 * The inbox demo routes exist only with at least one channel in
 * YSOCIAL_DEMO_INTEGRATIONS (PLAN 3.3 PR 26, only on staging). Without it
 * the answer is the same 404 as for any unknown route, before the token
 * check, like YsocialTestRoutesGuard. Runs in addition to
 * YsocialTokenGuard, never instead of it. Whether a channel is listed
 * checks YsocialInboxService on every call.
 */
@Injectable()
export class YsocialInboxDemoGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (inboxDemoEnabled(process.env)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Same text as the not-found handler of Nest.
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl}`
    );
  }
}
