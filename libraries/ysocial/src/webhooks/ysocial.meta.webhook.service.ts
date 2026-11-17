import { Injectable, Logger } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  WEBHOOK_LOG_KEY,
  WEBHOOK_LOG_LIMIT,
  WEBHOOK_LOG_TTL_S,
  WebhookEvent,
  webhookEvents,
} from './webhook.rules';

export interface YsocialWebhookLogStore {
  rpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

// Class name of an unexpected error for the log, never its message.
const errorName = (err: unknown) =>
  err instanceof Error && /^\w{1,60}$/.test(err.name) ? err.name : 'Error';

/**
 * Log of the Meta webhooks for the inbox demo (PR B). Keeps ids, field, kind
 * and time of the latest events in the Redis of Postiz with a TTL, no
 * table. Nothing else happens on a webhook: no reply, no ticket, no call to
 * Meta (rule 2). The text of a comment the demo reads through the inbox
 * routes.
 */
@Injectable()
export class YsocialMetaWebhookService {
  private readonly _logger = new Logger('ysocial');
  protected store: YsocialWebhookLogStore =
    ioRedis as unknown as YsocialWebhookLogStore;

  // Answers 200 whenever the signature was right, also if nothing could be
  // stored: Meta would only send the same payload again.
  async record(payload: unknown, now: Date = new Date()) {
    const events = webhookEvents(payload, now);
    const fields = [...new Set(events.map((event) => event.field))].join(',');
    const log = (result: string) =>
      this._logger.log(
        `meta webhook object=${events[0]?.object ?? '-'} events=${
          events.length
        } fields=${fields || '-'} result=${result}`
      );

    if (!events.length) {
      log('ignored');
      return { received: 0 };
    }
    try {
      for (const event of events) {
        await this.store.rpush(WEBHOOK_LOG_KEY, JSON.stringify(event));
      }
      await this.store.ltrim(WEBHOOK_LOG_KEY, -WEBHOOK_LOG_LIMIT, -1);
      await this.store.expire(WEBHOOK_LOG_KEY, WEBHOOK_LOG_TTL_S);
    } catch (err) {
      log(`store_failed error=${errorName(err)}`);
      return { received: events.length };
    }
    log('recorded');
    return { received: events.length };
  }

  // Newest first. An entry that is not valid JSON is left out.
  async events() {
    const raw = await this.store.lrange(
      WEBHOOK_LOG_KEY,
      -WEBHOOK_LOG_LIMIT,
      -1
    );
    const events = (raw || []).flatMap((value): WebhookEvent[] => {
      try {
        return [JSON.parse(value)];
      } catch (err) {
        return [];
      }
    });
    return {
      events: events.reverse(),
      limit: WEBHOOK_LOG_LIMIT,
      ttlSeconds: WEBHOOK_LOG_TTL_S,
    };
  }
}
