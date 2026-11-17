import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { HubEvent } from '../events/hub.event';
import { HubClientConfig, postHubEvent } from '../events/hub.client';
import { readHubClientConfig } from '../worker/worker.config';
import { YsocialWebhookRepository } from '../database/ysocial.webhook.repository';
import {
  demoLogEnabled,
  INBOX_WEBHOOK_BELLS_MAX,
  inboxEventsEnabled,
  inboxWebhookEvent,
  isCommentEvent,
  WEBHOOK_LOG_KEY,
  WEBHOOK_LOG_LIMIT,
  WEBHOOK_LOG_TTL_S,
  WEBHOOK_PROVIDERS,
  WebhookChannel,
  WebhookEvent,
  webhookEvents,
} from './webhook.rules';

export interface YsocialWebhookLogStore {
  rpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

// Meta waits for the answer to a webhook. One attempt per bell, sent side
// by side, at most this long.
export const BELL_TIMEOUT_MS = 5_000;

// Class name of an unexpected error for the log, never its message.
const errorName = (err: unknown) =>
  err instanceof Error && /^\w{1,60}$/.test(err.name) ? err.name : 'Error';

/**
 * Receiver of the Meta webhooks (PR B, for every Meta channel since Phase 3
 * PR 74). Per event:
 * - With the demo list the log in the Redis of Postiz: ids, field, kind and
 *   time of the latest events with a TTL, no table.
 * - For a comment the bell inbox.webhook to the hub, for each channel of the
 *   Page or account, with the same ids. One attempt, no Temporal: a lost
 *   bell the hub's fetch finds anyway (E81), under posts of the last 30
 *   days within 10 minutes, under older ones within an hour (E82).
 * Nothing else happens on a webhook: no reply, no ticket, no call to Meta
 * (rule 2). No text, no name.
 */
@Injectable()
export class YsocialMetaWebhookService {
  private readonly _logger = new Logger('ysocial');
  protected store: YsocialWebhookLogStore =
    ioRedis as unknown as YsocialWebhookLogStore;
  protected sendToHub = (event: HubEvent, config: HubClientConfig) =>
    postHubEvent(event, config, undefined, BELL_TIMEOUT_MS);

  constructor(private _channels: YsocialWebhookRepository) {}

  // Answers 200 whenever the signature was right, also if nothing could be
  // stored or rung: Meta would only send the same payload again.
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
    const stored = await this.storeEvents(events);
    const bells = await this.ring(events);
    log(`${stored}${bells}`);
    return { received: events.length };
  }

  // Newest first. An entry that is not valid JSON is left out. Without
  // Redis 503 store_unavailable, as an HttpException outside the Sentry
  // filter of Postiz.
  async events() {
    let raw: string[];
    try {
      raw = await this.store.lrange(WEBHOOK_LOG_KEY, -WEBHOOK_LOG_LIMIT, -1);
    } catch (err) {
      this._logger.log(
        `meta webhook events result=rejected code=store_unavailable error=${errorName(
          err
        )}`
      );
      throw new HttpException(
        { statusCode: 503, code: 'store_unavailable' },
        503
      );
    }
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

  // The demo log, only with the demo list.
  private async storeEvents(events: WebhookEvent[]) {
    if (!demoLogEnabled(process.env)) {
      return 'not_logged';
    }
    try {
      for (const event of events) {
        await this.store.rpush(WEBHOOK_LOG_KEY, JSON.stringify(event));
      }
      await this.store.ltrim(WEBHOOK_LOG_KEY, -WEBHOOK_LOG_LIMIT, -1);
      await this.store.expire(WEBHOOK_LOG_KEY, WEBHOOK_LOG_TTL_S);
    } catch (err) {
      return `store_failed error=${errorName(err)}`;
    }
    return 'recorded';
  }

  // The bells for the comments among the events. Returns the part of the
  // log line: counts only.
  private async ring(events: WebhookEvent[]) {
    const comments = events.filter(isCommentEvent);
    if (!inboxEventsEnabled(process.env) || !comments.length) {
      return ' bells=0';
    }
    const config = readHubClientConfig(process.env);
    if (!config) {
      return ' bells=not_configured';
    }

    try {
      const channelsOf = new Map<string, WebhookChannel[]>();
      const bells = new Map<string, HubEvent>();
      let unknown = 0;
      for (const event of comments) {
        const provider = WEBHOOK_PROVIDERS[event.object];
        if (!provider || !event.entryId) {
          unknown++;
          continue;
        }
        const key = `${provider}:${event.entryId}`;
        if (!channelsOf.has(key)) {
          channelsOf.set(
            key,
            await this._channels.getChannelsForWebhook(provider, event.entryId)
          );
        }
        const channels = channelsOf.get(key)!;
        if (!channels.length) {
          unknown++;
        }
        for (const channel of channels) {
          const bell = inboxWebhookEvent(event, channel);
          if (bell) {
            bells.set(bell.id, bell);
          }
        }
      }

      const ringing = [...bells.values()].slice(0, INBOX_WEBHOOK_BELLS_MAX);
      const sent = await Promise.all(
        ringing.map((bell) =>
          this.sendToHub(bell, config).then(
            () => true,
            () => false
          )
        )
      );
      const delivered = sent.filter(Boolean).length;
      return ` bells=${ringing.length} delivered=${delivered} failed=${
        ringing.length - delivered
      } unknown_channel=${unknown} dropped=${bells.size - ringing.length}`;
    } catch (err) {
      return ` bells=failed error=${errorName(err)}`;
    }
  }
}
