import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  RawBodyRequest,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  checkSignature,
  checkVerifyRequest,
  isChallenge,
  META_APP_SECRET_ENV,
  YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV,
} from '../../../../libraries/ysocial/src/webhooks/webhook.rules';

/**
 * Protects the receiver of the Meta webhooks instead of YsocialTokenGuard:
 * Meta cannot send the service token. Runs after YsocialInboxDemoGuard.
 *
 * - GET (verification request of the App Dashboard): hub.mode=subscribe and
 *   hub.verify_token equal to YSOCIAL_META_WEBHOOK_VERIFY_TOKEN, a numeric
 *   hub.challenge. Token not configured or shorter than 32 characters: 503.
 *   Otherwise wrong: 403.
 * - POST (event notification): X-Hub-Signature-256 equal to the HMAC-SHA256
 *   of the raw body with FACEBOOK_APP_SECRET, the App Secret Postiz already
 *   uses for Facebook Login. Secret not configured: 503. Header missing or
 *   signature wrong: 401. The raw body comes from NestFactory.create with
 *   rawBody: true in apps/backend/src/main.ts.
 *
 * Fail-closed: without the secret nothing gets through. Both comparisons run
 * in constant time. Neither token nor signature reaches the log.
 */
@Injectable()
export class YsocialMetaWebhookGuard implements CanActivate {
  private readonly _logger = new Logger('ysocial');

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const log = (step: string, result: string) =>
      this._logger.log(`meta webhook ${step} result=${result}`);

    if (request.method === 'POST') {
      const result = checkSignature(
        process.env,
        request.rawBody,
        request.headers['x-hub-signature-256']
      );
      if (result === 'ok') {
        return true;
      }
      if (result === 'not_configured') {
        log('receive', 'rejected code=not_configured');
        throw new ServiceUnavailableException(
          `${META_APP_SECRET_ENV} is not configured`
        );
      }
      log('receive', `rejected code=signature_${result}`);
      throw new UnauthorizedException();
    }

    const result = checkVerifyRequest(
      process.env,
      request.query['hub.mode'],
      request.query['hub.verify_token']
    );
    if (result === 'not_configured') {
      log('verify', 'rejected code=not_configured');
      throw new ServiceUnavailableException(
        `${YSOCIAL_META_WEBHOOK_VERIFY_TOKEN_ENV} is not configured`
      );
    }
    if (result !== 'ok' || !isChallenge(request.query['hub.challenge'])) {
      log('verify', 'rejected code=verify_invalid');
      throw new ForbiddenException();
    }
    log('verify', 'ok');
    return true;
  }
}
