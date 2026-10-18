import { Injectable, Logger } from '@nestjs/common';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { YsocialIntegrationRepository } from '../database/ysocial.integration.repository';
import { YsocialPostRepository } from '../database/ysocial.post.repository';
import { createHubEvent, HubEvent, sanitizeReason } from '../events/hub.event';
import {
  berlinDay,
  channelFlag,
  ChannelProblems,
  ChannelRow,
  diffChannels,
  tokenExpiringEvent,
} from './channel.health';
import {
  ChannelAuthResult,
  classifyAnalyticsError,
  classifyAnalyticsResult,
} from './channel.auth.rules';

// Which channels the checks reported, so they can report the way back.
// Redis of Postiz, no table (HANDOVER §5).
export const YSOCIAL_CHANNEL_PROBLEMS_KEY = 'ysocial:channel-problems';

export const FAILED_POSTS_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export interface YsocialProblemStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

export interface DailyHealthSummary {
  day: string;
  channels: number;
  platformCalls: number;
  skipped: number;
  disconnected: string[];
  authInvalid: string[];
  tokenExpiring: string[];
  unclear: string[];
  failedPosts: string[];
}

/**
 * Channel check (hourly, database only) and DailyHealth (07:00, with one
 * reading platform call per channel). PLAN 3.3 PR 18, E23.
 *
 * Only reading calls: the database and analytics of the provider for one
 * day. The token is read here and passed to analytics, it never leaves this
 * class. No token refresh, no change in Postiz.
 */
@Injectable()
export class YsocialChannelHealthService {
  private readonly _logger = new Logger('ysocial');
  protected store: YsocialProblemStore =
    ioRedis as unknown as YsocialProblemStore;

  constructor(
    private _integrations: YsocialIntegrationRepository,
    private _posts: YsocialPostRepository,
    private _integrationManager: IntegrationManager
  ) {}

  async checkChannels(now: Date = new Date()) {
    const channels = (await this._integrations.getChannels()) as ChannelRow[];
    const previous = await this.loadProblems();
    const { events, next } = diffChannels({
      previous,
      channels,
      now: now.getTime(),
    });
    await this.saveProblems(next);
    return { channels: channels.length, events };
  }

  async runDailyHealth(
    now: Date = new Date()
  ): Promise<{ events: HubEvent[]; summary: DailyHealthSummary }> {
    const at = now.getTime();
    const channels = (await this._integrations.getChannels()) as ChannelRow[];
    const authInvalid: Record<string, string> = {};
    const authOk: string[] = [];
    const unclear: string[] = [];
    const tokenEvents: HubEvent[] = [];
    let platformCalls = 0;
    let skipped = 0;

    for (const row of channels) {
      const expiring = tokenExpiringEvent(row, at);
      if (expiring) {
        tokenEvents.push(expiring);
      }

      // A disconnected channel or an expired token would only fail.
      if (channelFlag(row) || expiring?.data?.expired) {
        skipped++;
        continue;
      }

      const auth = await this.checkAuth(row);
      if (!auth) {
        skipped++;
        continue;
      }
      platformCalls++;
      if (auth.result === 'auth_invalid') {
        authInvalid[row.id] = sanitizeReason(auth.reason) || '';
      } else if (auth.result === 'ok') {
        authOk.push(row.id);
      } else {
        unclear.push(row.id);
      }
    }

    const previous = await this.loadProblems();
    const diff = diffChannels({
      previous,
      channels,
      now: at,
      authInvalid,
      authOk,
    });
    await this.saveProblems(diff.next);

    const failedPosts = await this._posts.findFailedPosts(
      new Date(at - FAILED_POSTS_DAYS * DAY_MS),
      now
    );
    const postEvents = failedPosts.map((post) => {
      const error = sanitizeReason(post.error);
      return createHubEvent({
        kind: 'post.failed',
        subject: { type: 'post', id: post.id },
        // Same id as PostVerification, the hub counts it once.
        stateKey: String(post.publishDate.getTime()),
        occurredAt: now,
        postiz: {
          organizationId: post.organizationId,
          integrationId: post.integrationId,
          postId: post.id,
          customerId: post.integration.customerId || null,
          providerIdentifier: post.integration.providerIdentifier,
        },
        reason: error
          ? `Postiz meldet einen Fehler beim Veröffentlichen. ${error}`
          : 'Postiz meldet einen Fehler beim Veröffentlichen.',
        data: { publishDate: post.publishDate.toISOString(), state: 'ERROR' },
      });
    });

    const summary: DailyHealthSummary = {
      day: berlinDay(at),
      channels: channels.length,
      platformCalls,
      skipped,
      disconnected: Object.entries(diff.next)
        .filter(([, state]) => state.kind === 'channel.disconnected')
        .map(([id]) => id),
      authInvalid: Object.entries(diff.next)
        .filter(([, state]) => state.kind === 'channel.auth_invalid')
        .map(([id]) => id),
      tokenExpiring: tokenEvents.map((event) => event.subject.id),
      unclear,
      failedPosts: failedPosts.map((post) => post.id),
    };

    // Inbox polling comes with phase 3 (W33), DailyHealth says nothing about it.
    const summaryEvent = createHubEvent({
      kind: 'health.daily',
      subject: { type: 'system', id: 'postiz' },
      stateKey: summary.day,
      occurredAt: now,
      reason: `Tagesprüfung: ${summary.channels} Kanäle, ${
        summary.disconnected.length + summary.authInvalid.length
      } getrennt oder ungültig, ${summary.tokenExpiring.length} mit Ablauf, ${
        summary.failedPosts.length
      } Fehlposts in 7 Tagen.`,
      data: { ...summary },
    });

    this._logger.log(
      `daily health: channels=${summary.channels} platform calls=${platformCalls} skipped=${skipped}`
    );

    return {
      events: [...diff.events, ...tokenEvents, ...postEvents, summaryEvent],
      summary,
    };
  }

  // The one platform call per channel. undefined: no call possible.
  private async checkAuth(
    row: ChannelRow
  ): Promise<ChannelAuthResult | undefined> {
    const provider = this._integrationManager.getSocialIntegration(
      row.providerIdentifier
    );
    if (typeof provider?.analytics !== 'function') {
      return undefined;
    }

    const channel = await this._integrations.getChannelForPlatformCheck(row.id);
    if (!channel) {
      return undefined;
    }

    let result: ChannelAuthResult;
    try {
      const analytics = await provider.analytics(
        channel.internalId,
        channel.token,
        1
      );
      result = classifyAnalyticsResult(row.providerIdentifier, analytics);
    } catch (err) {
      result = classifyAnalyticsError(row.providerIdentifier, err);
    }

    this._logger.log(
      `provider call analytics provider=${row.providerIdentifier} channel=${row.id} result=${result.result}`
    );
    return result;
  }

  private async loadProblems(): Promise<ChannelProblems> {
    try {
      const raw = await this.store.get(YSOCIAL_CHANNEL_PROBLEMS_KEY);
      const value = raw ? JSON.parse(raw) : {};
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      return {};
    }
  }

  private async saveProblems(problems: ChannelProblems) {
    await this.store.set(
      YSOCIAL_CHANNEL_PROBLEMS_KEY,
      JSON.stringify(problems)
    );
  }
}
