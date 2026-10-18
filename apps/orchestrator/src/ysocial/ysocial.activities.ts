import { Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { readYsocialWorkerConfig } from '../../../../libraries/ysocial/src/worker/worker.config';
import { HubEvent } from '../../../../libraries/ysocial/src/events/hub.event';
import {
  HubDeliveryError,
  postHubEvent,
} from '../../../../libraries/ysocial/src/events/hub.client';

/**
 * Activities of the ysocial worker. They run only on the task queue
 * ysocial-postiz in the namespace ysocial (PLAN E33).
 *
 * Activities are registered by method name. Every method here starts with
 * "ysocial", so no name can collide with a Postiz activity (PLAN R34). The
 * class has no @Activity decorator on purpose: nestjs-temporal-core must not
 * pick it up for the Postiz workers.
 */
@Injectable()
export class YsocialActivities {
  private readonly _logger = new Logger('ysocial');

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
