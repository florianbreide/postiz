import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  inboxDemoEnabled,
  inboxRoutesEnabled,
} from '../../../../libraries/ysocial/src/inbox/inbox.rules';

const YSOCIAL_INBOX_DEMO_ONLY = 'ysocialInboxDemoOnly';

// A route of the demo only (the webhooks, PR B): it exists with the demo
// list, not with YSOCIAL_INBOX_ENABLED alone.
export const InboxDemoOnly = () => SetMetadata(YSOCIAL_INBOX_DEMO_ONLY, true);

/**
 * The inbox routes exist with at least one channel in
 * YSOCIAL_DEMO_INTEGRATIONS (demo, PR 26) or with YSOCIAL_INBOX_ENABLED=true
 * (all Facebook and Instagram channels, Phase 3 PR 73). A route marked
 * InboxDemoOnly exists with the demo list only. Without it the answer is the
 * same 404 as for any unknown route, before the token check: guards of the
 * controller run before those of a route, so this guard decides for the
 * demo routes too. Runs in addition to YsocialTokenGuard, never instead of
 * it. Which channel a call may use checks YsocialInboxService on every call.
 */
@Injectable()
export class YsocialInboxGuard implements CanActivate {
  constructor(private _reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const demoOnly = this._reflector.get<boolean>(
      YSOCIAL_INBOX_DEMO_ONLY,
      context.getHandler()
    );
    if (
      demoOnly ? inboxDemoEnabled(process.env) : inboxRoutesEnabled(process.env)
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Same text as the not-found handler of Nest.
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl}`
    );
  }
}
