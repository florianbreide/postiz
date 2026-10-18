import { Injectable, Logger } from '@nestjs/common';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { YsocialPostRepository } from '../database/ysocial.post.repository';
import { sanitizeReason } from '../events/hub.event';
import {
  PlatformCheck,
  PostState,
  PostVerificationSnapshot,
  VERIFY_WINDOW_MAX_MINUTES,
  VERIFY_WINDOW_MINUTES,
} from './post.verification';
import { ruleFor } from './provider.rules';

// Days of metrics to ask for, like the statistics modal of Postiz. Facebook
// and Instagram ignore it.
const ANALYTICS_DAYS = 7;

const unverifiable = (reason: string): PlatformCheck => ({
  result: 'unverifiable',
  reason,
});

/**
 * Reads posts for PostVerification and checks a post on its platform.
 *
 * Only reading calls: the database and postAnalytics of the provider. The
 * channel token is read here and passed to postAnalytics, it never leaves
 * this class. No token refresh: that stays with Postiz.
 */
@Injectable()
export class YsocialPostVerificationService {
  private readonly _logger = new Logger('ysocial');

  constructor(
    private _posts: YsocialPostRepository,
    private _integrationManager: IntegrationManager
  ) {}

  async findPostIdsToVerify(
    now: Date,
    windowMinutes = VERIFY_WINDOW_MINUTES
  ): Promise<string[]> {
    const minutes = Math.min(
      VERIFY_WINDOW_MAX_MINUTES,
      Math.max(1, Math.round(windowMinutes) || VERIFY_WINDOW_MINUTES)
    );
    const from = new Date(now.getTime() - minutes * 60_000);
    const posts = await this._posts.findPostsToVerify(from, now);
    return posts.map((post) => post.id);
  }

  async loadSnapshot(postId: string): Promise<PostVerificationSnapshot | null> {
    const post = await this._posts.getPostForVerification(postId);
    if (!post) {
      return null;
    }

    const integration = post.integration;
    return {
      id: post.id,
      organizationId: post.organizationId,
      integrationId: post.integrationId,
      state: post.state as PostState,
      publishDate: post.publishDate.toISOString(),
      deleted: !!post.deletedAt,
      releaseURL: post.releaseURL || null,
      error: sanitizeReason(post.error) || null,
      integration: {
        providerIdentifier: integration.providerIdentifier,
        customerId: integration.customerId || null,
        disconnected:
          !!integration.deletedAt ||
          integration.disabled ||
          integration.refreshNeeded ||
          integration.inBetweenSteps,
      },
    };
  }

  async checkOnPlatform(
    postId: string,
    now: Date = new Date()
  ): Promise<PlatformCheck> {
    const post = await this._posts.getPostForPlatformCheck(postId);
    if (!post) {
      return unverifiable('Der Post ist nicht mehr in Postiz.');
    }

    const integration = post.integration;
    const identifier = integration.providerIdentifier;
    const rule = ruleFor(identifier);
    if (!rule) {
      return unverifiable(`Für ${identifier} gibt es noch keine Prüfung.`);
    }

    if (!post.releaseId || post.releaseId === 'missing') {
      return unverifiable(
        'Postiz kennt die ID des Posts auf der Plattform nicht.'
      );
    }

    if (
      integration.deletedAt ||
      integration.disabled ||
      integration.refreshNeeded ||
      integration.inBetweenSteps
    ) {
      return unverifiable(
        'Der Kanal ist getrennt, die Prüfung braucht einen gültigen Zugang.'
      );
    }

    if (
      integration.tokenExpiration &&
      integration.tokenExpiration.getTime() < now.getTime()
    ) {
      return unverifiable('Der Zugang des Kanals ist abgelaufen.');
    }

    const cannotCheck = rule.cannotCheck(post);
    if (cannotCheck) {
      return unverifiable(cannotCheck);
    }

    const provider = this._integrationManager.getSocialIntegration(identifier);
    if (typeof provider?.postAnalytics !== 'function') {
      return unverifiable(`${identifier} hat keine Methode postAnalytics.`);
    }

    // The one platform call of PostVerification. Errors go up: the activity
    // retries, then the workflow reports "nicht prüfbar".
    const result = await provider.postAnalytics(
      integration.internalId,
      integration.token,
      post.releaseId,
      ANALYTICS_DAYS
    );
    const answer = rule.classify(result);
    this._logger.log(
      `provider call postAnalytics provider=${identifier} post=${postId} result=${answer}`
    );
    return { result: answer };
  }
}
