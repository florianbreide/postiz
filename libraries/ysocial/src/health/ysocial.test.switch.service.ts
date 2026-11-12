import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  INVALID_TOKEN_SWITCH_TTL_S,
  invalidTokenSwitchKey,
  isTestIntegration,
  YSOCIAL_TEST_INTEGRATIONS_ENV,
} from './test.switch';

export interface YsocialSwitchStore {
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Sets and clears the test switch for the channel check (PLAN 3.3 PR 19).
 * Only Redis, never the stored channel token. YsocialChannelHealthService
 * reads the switch.
 */
@Injectable()
export class YsocialTestSwitchService {
  private readonly _logger = new Logger('ysocial');
  protected store: YsocialSwitchStore =
    ioRedis as unknown as YsocialSwitchStore;

  async setInvalidToken(integrationId: string, now: Date = new Date()) {
    this.checkTestIntegration(integrationId);
    const until = new Date(now.getTime() + INVALID_TOKEN_SWITCH_TTL_S * 1000);
    await this.store.set(
      invalidTokenSwitchKey(integrationId),
      JSON.stringify({ since: now.toISOString(), until: until.toISOString() }),
      'EX',
      INVALID_TOKEN_SWITCH_TTL_S
    );
    this._logger.log(
      `test switch invalid token on channel=${integrationId} until=${until.toISOString()}`
    );
    return { integrationId, invalidToken: true, until: until.toISOString() };
  }

  async clearInvalidToken(integrationId: string) {
    this.checkTestIntegration(integrationId);
    await this.store.del(invalidTokenSwitchKey(integrationId));
    this._logger.log(`test switch invalid token off channel=${integrationId}`);
    return { integrationId, invalidToken: false };
  }

  private checkTestIntegration(integrationId: string) {
    if (!isTestIntegration(process.env, integrationId)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'not_test_integration',
        message: `channel is not listed in ${YSOCIAL_TEST_INTEGRATIONS_ENV}`,
      });
    }
  }
}
