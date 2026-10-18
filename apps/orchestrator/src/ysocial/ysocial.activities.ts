import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationFailure,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';
import { WorkflowStartOptions } from '@temporalio/client';
import {
  readYsocialWorkerConfig,
  YSOCIAL_TASK_QUEUE,
} from '../../../../libraries/ysocial/src/worker/worker.config';
import { HubEvent } from '../../../../libraries/ysocial/src/events/hub.event';
import {
  HubDeliveryError,
  postHubEvent,
} from '../../../../libraries/ysocial/src/events/hub.client';
import { YsocialPostVerificationService } from '../../../../libraries/ysocial/src/verification/ysocial.post.verification.service';
import {
  PlatformCheck,
  PostVerificationSnapshot,
} from '../../../../libraries/ysocial/src/verification/post.verification';
import {
  DailyHealthSummary,
  YsocialChannelHealthService,
} from '../../../../libraries/ysocial/src/health/ysocial.channel.health.service';
import { YsocialTemporalClient } from './ysocial.temporal.client';

export const verifyPostWorkflowId = (postId: string) =>
  `ysocial-verify-${postId}`;

// One verification per post: the workflow id is rejected as long as Temporal
// keeps the closed run. No search attributes (E13).
export const verifyPostStartOptions = (
  postId: string,
  taskQueue = YSOCIAL_TASK_QUEUE
): WorkflowStartOptions => ({
  workflowId: verifyPostWorkflowId(postId),
  taskQueue,
  args: [{ postId }],
  workflowIdReusePolicy: 'REJECT_DUPLICATE',
});

/**
 * Activities of the ysocial worker. They run only on the task queue
 * ysocial-postiz in the namespace ysocial (PLAN E33).
 *
 * Activities are registered by method name. Every method here starts with
 * "ysocial", so no name can collide with a Postiz activity (PLAN R34). The
 * class has no @Activity decorator on purpose: nestjs-temporal-core must not
 * pick it up for the Postiz workers.
 *
 * Parameters are single objects, so a later field does not change the
 * signature of an activity that running workflows already call.
 */
@Injectable()
export class YsocialActivities {
  private readonly _logger = new Logger('ysocial');

  constructor(
    private _verification: YsocialPostVerificationService,
    private _temporal: YsocialTemporalClient,
    private _channelHealth: YsocialChannelHealthService
  ) {}

  async ysocialDeliverEvent(
    event: HubEvent
  ): Promise<{ status: number; duplicate: boolean }> {
    const result = readYsocialWorkerConfig(process.env);
    if (!result.ok) {
      // The worker only runs when configured, a restart with the variables
      // lets the next attempt through.
      throw ApplicationFailure.retryable(
        'ysocial worker is not configured',
        'YsocialNotConfigured'
      );
    }

    try {
      const delivered = await postHubEvent(event, result.config!);
      this._logger.log(
        `event ${event.id} delivered to hub (${delivered.status})`
      );
      return delivered;
    } catch (err) {
      if (err instanceof HubDeliveryError) {
        this._logger.warn(`event ${event.id}: ${err.message}`);
        if (err.retryable) {
          throw ApplicationFailure.retryable(
            err.message,
            'YsocialHubUnavailable'
          );
        }
        throw ApplicationFailure.nonRetryable(
          err.message,
          'YsocialHubRejected'
        );
      }
      throw err;
    }
  }

  // PostVerification: starts ysocial-verify-<postId> for every due post.
  // A post that already has its workflow is skipped by Temporal.
  async ysocialStartPostVerifications(input?: {
    windowMinutes?: number;
  }): Promise<{ due: number; started: number; alreadyStarted: number }> {
    const postIds = await this._verification.findPostIdsToVerify(
      new Date(),
      input?.windowMinutes
    );
    if (!postIds.length) {
      return { due: 0, started: 0, alreadyStarted: 0 };
    }

    const client = await this._temporal.get();
    const taskQueue =
      readYsocialWorkerConfig(process.env).config?.taskQueue ||
      YSOCIAL_TASK_QUEUE;
    let started = 0;
    let alreadyStarted = 0;
    for (const postId of postIds) {
      try {
        await client.workflow.start(
          'ysocialVerifyPostWorkflow',
          verifyPostStartOptions(postId, taskQueue)
        );
        started++;
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
          throw err;
        }
        alreadyStarted++;
      }
    }

    if (started) {
      this._logger.log(
        `post verification started for ${started} of ${postIds.length} posts`
      );
    }
    return { due: postIds.length, started, alreadyStarted };
  }

  async ysocialLoadPostForVerification(input: {
    postId: string;
  }): Promise<PostVerificationSnapshot | null> {
    return this._verification.loadSnapshot(input.postId);
  }

  async ysocialCheckPostOnPlatform(input: {
    postId: string;
  }): Promise<PlatformCheck> {
    return this._verification.checkOnPlatform(input.postId);
  }

  // Hourly channel check from the database fields, no platform call.
  async ysocialCheckChannels(
    _input?: Record<string, never>
  ): Promise<{ channels: number; events: HubEvent[] }> {
    return this._channelHealth.checkChannels();
  }

  // DailyHealth: database fields, one reading platform call per channel,
  // posts in ERROR of the last 7 days.
  async ysocialRunDailyHealth(
    _input?: Record<string, never>
  ): Promise<{ events: HubEvent[]; summary: DailyHealthSummary }> {
    return this._channelHealth.runDailyHealth();
  }
}

// Methods of YsocialActivities that the worker registers.
export const ysocialActivityNames = (): string[] =>
  Object.getOwnPropertyNames(YsocialActivities.prototype).filter(
    (name) => name !== 'constructor'
  );

export const buildYsocialActivities = (
  instance: YsocialActivities
): Record<string, (...args: any[]) => Promise<unknown>> =>
  Object.fromEntries(
    ysocialActivityNames().map((name) => [
      name,
      (instance as any)[name].bind(instance),
    ])
  );
