import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { testRoutesEnabled } from '../../../../libraries/ysocial/src/health/test.switch';

/**
 * Test routes exist only with YSOCIAL_TEST_ROUTES=true (PLAN 3.3 PR 19, only
 * on staging). Without it the answer is the same 404 as for any unknown
 * route, before the token check. Runs in addition to YsocialTokenGuard,
 * never instead of it.
 */
@Injectable()
export class YsocialTestRoutesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (testRoutesEnabled(process.env)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    // Same text as the not-found handler of Nest.
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl}`
    );
  }
}
