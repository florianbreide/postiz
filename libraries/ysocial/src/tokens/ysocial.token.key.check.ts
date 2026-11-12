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
    const key = readYsocialTokenKey(env);
    const integration = this._integration.model.integration;

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

    // One row decrypted as a probe: the extension decrypts on access and
    // throws YsocialTokenKeyError if a value was changed.
    const probe = await integration.findFirst({
      where: {
        OR: YSOCIAL_TOKEN_FIELDS.map((field) =>
          storedTokenStartsWith(field, ownPrefix)
        ),
      },
      select: { token: true, refreshToken: true },
    });
    if (probe) {
      String(probe.token);
      String(probe.refreshToken);
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
