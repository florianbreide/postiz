import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  AUTOMATION_BLOCKED_CODE,
  AUTOMATION_BLOCKED_MESSAGE,
  automatedPost,
  hasInternalPlug,
} from '../../../../libraries/ysocial/src/automation/automation.rules';

/**
 * Refuses what makes Postiz post without a person's approval (Rule 2, D15),
 * on the Postiz routes YsocialModule.configure lists:
 * - POST /posts and POST /public/v1/posts (CreatePostDto): inter above 0
 *   ("Repeat Post") or an internal plug in posts[].settings,
 * - PUT /public/v1/posts/:id/settings: an internal plug in settings,
 * - POST /integrations/:id/plugs: creating a global plug activates it,
 * - PUT /integrations/plugs/:id/activate with a truthy status (Postiz
 *   stores !!status). Switching off stays allowed.
 * 403 automation_blocked, before the controller. No switch: the rule holds
 * for every channel, the ones of Y Social as well. The log names the kind
 * only, never the body.
 */
@Injectable()
export class YsocialAutomationMiddleware implements NestMiddleware {
  private readonly _logger = new Logger('ysocial');

  use(req: Request, res: Response, next: NextFunction) {
    const reason = this.reason(req);
    if (!reason) {
      return next();
    }
    this._logger.log(
      `automation blocked method=${req.method} reason=${reason}`
    );
    throw new ForbiddenException({
      statusCode: 403,
      code: AUTOMATION_BLOCKED_CODE,
      message: AUTOMATION_BLOCKED_MESSAGE,
    });
  }

  private reason(req: Request) {
    const path = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    if (req.method === 'PUT' && /\/settings$/i.test(path)) {
      return hasInternalPlug(req.body?.settings) ? 'plug' : null;
    }
    if (req.method === 'PUT') {
      // Postiz stores activated: !!status, the body is not converted.
      return /\/activate$/i.test(path) && !!req.body?.status
        ? 'global-plug'
        : null;
    }
    if (/\/plugs$/i.test(path)) {
      return 'global-plug';
    }
    return automatedPost(req.body);
  }
}
