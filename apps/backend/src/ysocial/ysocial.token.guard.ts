import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  checkServiceToken,
  YSOCIAL_SERVICE_TOKEN_ENV,
} from '../../../../libraries/ysocial/src/service.token';

/**
 * Protects every internal ysocial route with YSOCIAL_SERVICE_TOKEN.
 *
 * Postiz's global guards let a new controller through (PoliciesGuard only
 * checks routes with @CheckPolicies, the throttler only a few public routes)
 * and the auth middleware is bound to a fixed list of Postiz controllers.
 * So this guard is the only protection and must stay on every ysocial
 * controller.
 *
 * - token not configured (or too short): 503, nobody gets in (fail-closed)
 * - Authorization header missing or wrong: 401
 * - correct "Authorization: Bearer <token>": request passes
 */
@Injectable()
export class YsocialTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const result = checkServiceToken(
      process.env[YSOCIAL_SERVICE_TOKEN_ENV],
      request.headers.authorization
    );

    if (result === 'ok') {
      return true;
    }

    if (result === 'not_configured') {
      throw new ServiceUnavailableException(
        'ysocial service token is not configured'
      );
    }

    http
      .getResponse<Response>()
      .setHeader('WWW-Authenticate', 'Bearer realm="ysocial"');
    throw new UnauthorizedException();
  }
}
