import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CUSTOMER_FIELDS,
  INTEGRATION_FIELDS,
  POST_FIELDS,
  YsocialReadRepository,
} from '../database/ysocial.read.repository';
import { sanitizeReason } from '../events/hub.event';
import { channelFlag, ChannelRow } from '../health/channel.health';

export const POSTS_MAX_RANGE_DAYS = 31;

// Copies only the listed fields. The selects already limit the columns,
// this keeps the response fixed even if a select changes.
const pick = <T extends Record<string, true>>(
  row: Record<string, unknown>,
  fields: T
): { [K in keyof T]: unknown } =>
  Object.fromEntries(
    Object.keys(fields).map((key) => [key, row[key] ?? null])
  ) as { [K in keyof T]: unknown };

/**
 * Read API for the hub: customers, channels and posts of Postiz with fixed
 * field lists (PLAN 3.3 PR 18). Read-only.
 */
@Injectable()
export class YsocialReadService {
  constructor(private _read: YsocialReadRepository) {}

  async getCustomers() {
    const rows = await this._read.getCustomers();
    return rows.map((row) => pick(row, CUSTOMER_FIELDS));
  }

  async getIntegrations() {
    const rows = await this._read.getIntegrations();
    return rows.map((row) => ({
      ...pick(row, INTEGRATION_FIELDS),
      // ok, refresh_needed, in_between_steps or disabled
      status: channelFlag(row as unknown as ChannelRow) || 'ok',
    }));
  }

  async getPosts(fromValue: string, toValue: string) {
    const from = new Date(fromValue);
    const to = new Date(toValue);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be ISO 8601 dates');
    }
    if (to <= from) {
      throw new BadRequestException('to must be after from');
    }
    if (
      to.getTime() - from.getTime() >
      POSTS_MAX_RANGE_DAYS * 24 * 60 * 60_000
    ) {
      throw new BadRequestException(
        `at most ${POSTS_MAX_RANGE_DAYS} days per request`
      );
    }

    const rows = await this._read.getPosts(from, to);
    return rows.map((row) => ({
      ...pick(row, POST_FIELDS),
      error: sanitizeReason(row.error) || null,
    }));
  }
}
