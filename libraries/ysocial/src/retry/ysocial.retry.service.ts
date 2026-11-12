import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { YsocialRetryRepository } from '../database/ysocial.retry.repository';
import { sanitizeReason } from '../events/hub.event';
import {
  parseActor,
  postTaskQueue,
  retryDecision,
  RetryPostRow,
} from './retry.rules';

/**
 * "Erneut versuchen" for the hub (PLAN 3.3 PR 19). Sets the post from ERROR
 * to QUEUE and starts the Postiz post workflow through
 * PostsService.startWorkflow. Never calls a provider itself: Postiz posts.
 *
 * The hub checks the role of the person (E32) and sends who it was in
 * X-Ysocial-Actor. That value goes into the log, the post text never does.
 */
@Injectable()
export class YsocialRetryService {
  private readonly _logger = new Logger('ysocial');

  constructor(
    private _retry: YsocialRetryRepository,
    private _postsService: PostsService,
    private _temporalService: TemporalService
  ) {}

  async retry(
    id: string,
    actorHeader: string | undefined,
    confirmUnclear = false
  ) {
    const actor = parseActor(actorHeader);
    if (!actor) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'actor_missing',
        message: 'X-Ysocial-Actor is required: an e-mail address or an id',
      });
    }

    const post = (await this._retry.getPostForRetry(id)) as RetryPostRow | null;
    // Only ids from the database go into the log, never the raw path.
    const log = (result: string) =>
      this._logger.log(
        `retry post=${post ? post.id : '-'} actor=${actor} result=${result}`
      );
    const reject = ({
      status,
      ...body
    }: {
      status: number;
      code: string;
      [field: string]: unknown;
    }) => {
      log(`rejected code=${body.code}`);
      return new HttpException({ statusCode: status, ...body }, status);
    };

    const decision = retryDecision(post);
    if (decision.ok === false) {
      throw reject(decision.rejection);
    }

    // Postiz sets ERROR and may still try again in the same workflow.
    // startWorkflow would terminate it, its provider call may run on and
    // publish, and the new workflow would publish a second time.
    let running: boolean;
    try {
      running = await this.hasRunningWorkflow(post.id);
    } catch (err) {
      // startWorkflow swallows its errors: without Temporal the post would
      // stay in QUEUE without a workflow. Change nothing instead.
      this._logger.warn(
        `retry post=${post.id} temporal: ${
          sanitizeReason(err instanceof Error ? err.message : String(err)) ||
          'unknown error'
        }`
      );
      throw reject({ status: 503, code: 'temporal_unavailable' });
    }
    if (running) {
      throw reject({ status: 409, code: 'workflow_running' });
    }

    if (decision.unclear && !confirmUnclear) {
      throw reject({
        status: 409,
        code: 'unclear_outcome',
        reason: decision.unclear,
      });
    }

    if (!(await this._retry.queueFailedPost(post.id))) {
      throw reject({ status: 409, code: 'state_changed' });
    }

    await this._postsService.startWorkflow(
      postTaskQueue(post.integration.providerIdentifier),
      post.id,
      post.organizationId,
      'QUEUE'
    );

    log(`started${decision.unclear ? ` confirmed=${decision.unclear}` : ''}`);
    return { id: post.id, state: 'QUEUE' as const };
  }

  // Same query as PostsService.startWorkflow uses before it terminates.
  private async hasRunningWorkflow(postId: string) {
    const client = this._temporalService.client.getRawClient();
    if (!client) {
      throw new Error('temporal client not ready');
    }
    for await (const _ of client.workflow.list({
      query: `postId="${postId}" AND ExecutionStatus="Running"`,
    })) {
      return true;
    }
    return false;
  }
}
