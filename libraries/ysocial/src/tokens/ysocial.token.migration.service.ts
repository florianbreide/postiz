import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  readYsocialTokenKey,
  YSOCIAL_TOKEN_FIELDS,
  YSOCIAL_TOKEN_KEY_ENV,
  YSOCIAL_TOKEN_PREFIX,
  YsocialTokenField,
  YsocialTokenKeyError,
} from './token.crypto';
import { storedTokenStartsWith } from './ysocial.token.key.check';

export const YSOCIAL_TOKEN_MIGRATION_BATCH = 100;
const MAX_BATCH = 500;

export interface YsocialTokenMigrationCount {
  encrypted: number;
  // Changed by Postiz between reading and writing, e.g. by a token refresh.
  // That write already went through the extension.
  changedMeanwhile: number;
  // Plaintext values left after the run. 0 after a run with the key.
  remaining: number;
}

export type YsocialTokenMigrationResult = Record<
  YsocialTokenField,
  YsocialTokenMigrationCount
>;

/**
 * Migration of plaintext channel tokens to ys1 (PLAN PR 25). Runs only when
 * started by hand: workflow ysocialTokenMigrationWorkflow, see
 * apps/orchestrator/src/ysocial/README.md. Nothing is rewritten at start.
 *
 * Every channel, also deleted ones. A value is read through the extension
 * (plaintext comes back as it is) and written back with a condition on the
 * stored value. The extension encrypts the data but never the where, so a
 * value that Postiz changed in between is not overwritten. Repeating the run
 * is safe.
 *
 * The result holds counts only, no token reaches the Temporal history.
 */
@Injectable()
export class YsocialTokenMigrationService {
  private readonly _logger = new Logger('ysocial');

  constructor(private _integration: PrismaRepository<'integration'>) {}

  async migrate(
    batchSize = YSOCIAL_TOKEN_MIGRATION_BATCH
  ): Promise<YsocialTokenMigrationResult> {
    if (!readYsocialTokenKey(process.env)) {
      throw new YsocialTokenKeyError(
        `${YSOCIAL_TOKEN_KEY_ENV} fehlt: ohne Schlüssel verschlüsselt die Migration nichts`
      );
    }

    const take = Math.min(Math.max(Math.floor(batchSize) || 1, 1), MAX_BATCH);
    const result = {} as YsocialTokenMigrationResult;
    for (const field of YSOCIAL_TOKEN_FIELDS) {
      result[field] = await this.migrateField(field, take);
      this._logger.log(
        `token migration ${field}: encrypted=${result[field].encrypted} changed meanwhile=${result[field].changedMeanwhile} remaining=${result[field].remaining}`
      );
    }
    return result;
  }

  private async migrateField(
    field: YsocialTokenField,
    take: number
  ): Promise<YsocialTokenMigrationCount> {
    const integration = this._integration.model.integration;
    // token is required, refreshToken may be null.
    const plaintext: Prisma.IntegrationWhereInput = {
      AND: [
        ...(field === 'refreshToken' ? [{ refreshToken: { not: null } }] : []),
        { NOT: storedTokenStartsWith(field, YSOCIAL_TOKEN_PREFIX) },
      ],
    };

    let encrypted = 0;
    let changedMeanwhile = 0;
    let lastId: string | undefined;
    for (;;) {
      const rows = await integration.findMany({
        where: {
          AND: [plaintext, ...(lastId ? [{ id: { gt: lastId } }] : [])],
        },
        select: { id: true, token: true, refreshToken: true },
        orderBy: { id: 'asc' },
        take,
      });
      if (!rows.length) {
        break;
      }

      for (const row of rows) {
        // Plaintext comes back as it is stored. Only this field is read.
        const value = { [field]: row[field] } as {
          [name in YsocialTokenField]?: string;
        };
        const { count } = await integration.updateMany({
          where: { id: row.id, ...value },
          data: value,
        });
        if (count) {
          encrypted++;
        } else {
          changedMeanwhile++;
        }
      }
      lastId = rows[rows.length - 1].id;
    }

    const remaining = await integration.count({ where: plaintext });
    return { encrypted, changedMeanwhile, remaining };
  }
}
