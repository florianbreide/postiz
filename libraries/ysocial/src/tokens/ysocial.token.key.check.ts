import { FactoryProvider, Logger } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  readYsocialTokenKey,
  YSOCIAL_TOKEN_FIELDS,
  YSOCIAL_TOKEN_KEY_ENV,
  YSOCIAL_TOKEN_PREFIX,
  YsocialTokenField,
  YsocialTokenKeyError,
} from './token.crypto';

// The token encryption of Postiz itself (v2.26.0, #2430): it encrypts in
// IntegrationRepository and PostsRepository with the prefix enc:v1:. The
// ysocial module reads tokens through Prisma below that (inbox, channel
// check, deletion job) and would send the cipher to the platforms, so it
// stays off (YSOCIAL-PATCHES.md, ENCRYPTION_PROVIDER).
export const POSTIZ_ENCRYPTION_ENV = 'ENCRYPTION_PROVIDER';
export const POSTIZ_TOKEN_PREFIX = 'enc:v1:';

export interface YsocialTokenKeyState {
  encryption: 'on' | 'off';
  kid?: string;
}

// Filter on the stored value of one token field.
export const storedTokenStartsWith = (
  field: YsocialTokenField,
  prefix: string
) =>
  ({ [field]: { startsWith: prefix } } as {
    [name in YsocialTokenField]?: { startsWith: string };
  });

/**
 * Start check of the token key (PLAN E24, PR 25), fail-closed. It throws if
 *
 * - ENCRYPTION_PROVIDER of Postiz is set, or a token carries its prefix
 *   enc:v1:, stored as it is or inside our own encryption, every row with
 *   the own key read (since 0.10.2),
 * - YSOCIAL_TOKEN_KEY is set but not 32 bytes in base64,
 * - no key is set, but encrypted tokens exist,
 * - tokens are encrypted with another key (key id in the value).
 *
 * The filters compare the stored value, the extension does not change where.
 * The messages carry counts and key ids, never a token.
 */
export class YsocialTokenKeyCheck {
  private readonly _logger = new Logger('ysocial');

  constructor(private _integration: PrismaRepository<'integration'>) {}

  async run() {
    try {
      const state = await this.check(process.env);
      this._logger.log(
        state.encryption === 'on'
          ? `token encryption on (key ${state.kid})`
          : `token encryption off: ${YSOCIAL_TOKEN_KEY_ENV} fehlt, Kanal-Tokens bleiben Klartext`
      );
    } catch (err) {
      if (err instanceof YsocialTokenKeyError) {
        this._logger.error(`token key check failed: ${err.message}`);
      }
      throw err;
    }
  }

  async check(
    env: Record<string, string | undefined>
  ): Promise<YsocialTokenKeyState> {
    if (env[POSTIZ_ENCRYPTION_ENV]?.trim()) {
      throw new YsocialTokenKeyError(
        `${POSTIZ_ENCRYPTION_ENV} ist gesetzt: Die Token-Verschlüsselung von Postiz bleibt aus, das ysocial-Modul läse sonst die Chiffre (YSOCIAL-PATCHES.md)`
      );
    }
    const key = readYsocialTokenKey(env);
    const integration = this._integration.model.integration;
    const postizEncrypted = await integration.count({
      where: {
        OR: YSOCIAL_TOKEN_FIELDS.map((field) =>
          storedTokenStartsWith(field, POSTIZ_TOKEN_PREFIX)
        ),
      },
    });
    if (postizEncrypted) {
      throw new YsocialTokenKeyError(
        `${postizEncrypted} Kanäle haben Tokens mit der Verschlüsselung von Postiz (${POSTIZ_TOKEN_PREFIX}), damit startet Postiz nicht: die Kanäle neu verbinden (YSOCIAL-PATCHES.md, ${POSTIZ_ENCRYPTION_ENV})`
      );
    }

    if (!key) {
      const encrypted = await integration.count({
        where: {
          OR: YSOCIAL_TOKEN_FIELDS.map((field) =>
            storedTokenStartsWith(field, YSOCIAL_TOKEN_PREFIX)
          ),
        },
      });
      if (encrypted) {
        throw new YsocialTokenKeyError(
          `${YSOCIAL_TOKEN_KEY_ENV} fehlt: ${encrypted} Kanäle haben verschlüsselte Tokens, ohne den Schlüssel startet Postiz nicht`
        );
      }
      return { encryption: 'off' };
    }

    // One query per field for values with another key. Postiz may encrypt
    // values meanwhile (refresh, migration), they all carry the own key id.
    const ownPrefix = `${YSOCIAL_TOKEN_PREFIX}${key.kid}:`;
    for (const field of YSOCIAL_TOKEN_FIELDS) {
      const foreign = {
        AND: [
          storedTokenStartsWith(field, YSOCIAL_TOKEN_PREFIX),
          { NOT: storedTokenStartsWith(field, ownPrefix) },
        ],
      };
      const count = await integration.count({ where: foreign });
      if (count) {
        // Reading one of them through the extension throws, the error
        // carries the stored key id.
        const row = await integration.findFirst({
          where: foreign,
          select: { token: true, refreshToken: true },
        });
        let stored = 'unbekannt';
        try {
          String(row?.[field]);
        } catch (err) {
          if (err instanceof YsocialTokenKeyError && err.storedKid) {
            stored = err.storedKid;
          }
        }
        throw new YsocialTokenKeyError(
          `${YSOCIAL_TOKEN_KEY_ENV} passt nicht: ${count} Kanäle haben ${field} mit Schlüssel ${stored} verschlüsselt, ${YSOCIAL_TOKEN_KEY_ENV} hat ${key.kid}`,
          stored
        );
      }
    }

    // Every row with the own key decrypted (one row per channel): the
    // extension decrypts on access and throws YsocialTokenKeyError if a
    // value was changed, and the cipher of Postiz must not be inside.
    const rows = await integration.findMany({
      where: {
        OR: YSOCIAL_TOKEN_FIELDS.map((field) =>
          storedTokenStartsWith(field, ownPrefix)
        ),
      },
      select: { token: true, refreshToken: true },
    });
    const wrapped = rows.filter((row) =>
      YSOCIAL_TOKEN_FIELDS.some((field) =>
        String(row[field] ?? '').startsWith(POSTIZ_TOKEN_PREFIX)
      )
    ).length;
    if (wrapped) {
      throw new YsocialTokenKeyError(
        `${wrapped} Kanäle haben unter ${YSOCIAL_TOKEN_KEY_ENV} Tokens mit der Verschlüsselung von Postiz (${POSTIZ_TOKEN_PREFIX}), damit startet Postiz nicht: die Kanäle neu verbinden (YSOCIAL-PATCHES.md, ${POSTIZ_ENCRYPTION_ENV})`
      );
    }

    return { encryption: 'on', kid: key.kid };
  }
}

// Provider in YsocialModule (backend) and YsocialOrchestratorModule. Nest
// awaits the factory while NestFactory.create builds the providers, a failure
// there ends the process with exit code 1 before a port or a Temporal worker
// starts. An onModuleInit hook would run in app.listen(), and the backend only
// logs errors from there.
export const ysocialTokenKeyCheckProvider: FactoryProvider = {
  provide: YsocialTokenKeyCheck,
  inject: [PrismaRepository],
  useFactory: async (integration: PrismaRepository<'integration'>) => {
    const check = new YsocialTokenKeyCheck(integration);
    await check.run();
    return check;
  },
};
