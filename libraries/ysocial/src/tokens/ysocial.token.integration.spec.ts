// The real IntegrationManager loads every provider, some of them ESM-only.
// Providers are faked in the tests below.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

// Services around the code under test. Their imports pull in mail, media and
// AI code that does not compile under the strict ts-jest settings of this
// folder, and the test never calls them.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class IntegrationService {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({
    NotificationService: class NotificationService {},
    NotificationType: {},
  })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class MediaService {} })
);
jest.mock('@gitroom/nestjs-libraries/short-linking/short.link.service', () => ({
  ShortLinkService: class ShortLinkService {},
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({
  OpenaiService: class OpenaiService {},
}));

// file-type is ESM only and only used for uploads.
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));

// Sanitizing of post content is not under test and loads jsdom (ESM).
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (html: string) => html, addHook: jest.fn() },
}));

// The ysocial jest config replaces @prisma/client with a stub. This test
// talks to a real database, so it gets the generated client.
jest.mock('@prisma/client', () =>
  jest.requireActual(
    require('path').join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      '@prisma',
      'client'
    )
  )
);

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import {
  decryptYsocialToken,
  readYsocialTokenKey,
  YSOCIAL_TOKEN_KEY_ENV,
  YsocialTokenKeyError,
} from './token.crypto';

/**
 * Token encryption against a real Prisma client and a real Postgres (PR 25
 * QA). Skipped unless YSOCIAL_IT_DATABASE_URL is set, for example
 * postgresql://ysocial_it@localhost:5432/ysocial_it. The host must be
 * localhost or 127.0.0.1, the test always works in the schema ysocial_it and
 * resets it with prisma db push. The URL is never printed.
 *
 * The Postiz classes are the real ones (PrismaService, IntegrationRepository,
 * PostsRepository, PostsService, PostActivity, RefreshIntegrationService),
 * only the providers and the services around them are faked.
 */
const databaseUrl = process.env.YSOCIAL_IT_DATABASE_URL;
const describeIt = databaseUrl ? describe : describe.skip;

// Tests require Postiz services lazily, ts-jest compiles them on the first
// require. On the CI runner that takes longer than the default 5 s.
jest.setTimeout(60_000);

const ROOT = join(__dirname, '..', '..', '..', '..');
const SCHEMA = join(
  ROOT,
  'libraries',
  'nestjs-libraries',
  'src',
  'database',
  'prisma',
  'schema.prisma'
);
const IT_SCHEMA = 'ysocial_it';

const newKeyBase64 = () => randomBytes(32).toString('base64');

// Local URL with the fixed schema. Fails before anything touches a database
// that is not local.
const localUrl = (url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('YSOCIAL_IT_DATABASE_URL ist keine gültige URL');
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      'YSOCIAL_IT_DATABASE_URL: der Integrationstest läuft nur gegen localhost oder 127.0.0.1'
    );
  }
  parsed.searchParams.set('schema', IT_SCHEMA);
  return parsed.toString();
};

// Relations to Integration, read from schema.prisma: "Model.field".
const schemaRelationsToIntegration = () => {
  const source = readFileSync(SCHEMA, 'utf8');
  const blocks = [...source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  return blocks
    .flatMap(([, model, body]) =>
      body
        .split('\n')
        .map((line) => line.trim().match(/^(\w+)\s+(\w+)(\[\])?(\?)?/))
        .filter((m): m is RegExpMatchArray => !!m && m[2] === 'Integration')
        .map((m) => `${model}.${m[1]}`)
    )
    .sort();
};

describeIt('token encryption with a real database', () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    KEY: process.env[YSOCIAL_TOKEN_KEY_ENV],
    STRIPE: process.env.STRIPE_SECRET_KEY,
  };
  const keyBase64 = newKeyBase64();
  const key = readYsocialTokenKey({
    [YSOCIAL_TOKEN_KEY_ENV]: keyBase64,
  })!;

  // Set up in beforeAll, after the environment is in place.
  let prisma: any; // the real, patched PrismaService
  let raw: any; // a second, plain client: the stored values
  let repo: (name: string) => any;
  let integrationRepository: any;
  let url: string;

  const stored = async (id: string) =>
    (await raw.integration.findUnique({ where: { id } })) as {
      token: string;
      refreshToken: string | null;
    };

  const isCipher = (value: unknown, field: 'token' | 'refreshToken') =>
    typeof value === 'string' &&
    value.startsWith(`ys1:${key.kid}:`) &&
    decryptYsocialToken(value, field, key) !== undefined;

  let counter = 0;
  const unique = (prefix: string) =>
    `${prefix}-${++counter}-${randomBytes(3).toString('hex')}`;

  const integrationData = (organizationId: string, extra: object = {}) => ({
    name: 'channel',
    internalId: unique('internal'),
    organizationId,
    providerIdentifier: 'x',
    type: 'social',
    token: unique('plain-token'),
    refreshToken: unique('plain-refresh'),
    ...extra,
  });

  const makeOrg = (name = unique('org')) =>
    raw.organization.create({ data: { name } }) as Promise<{ id: string }>;

  const cleanDatabase = async () => {
    await raw.post.deleteMany({});
    await raw.integration.deleteMany({});
    await raw.customer.deleteMany({});
    await raw.organization.deleteMany({});
  };

  beforeAll(() => {
    url = localUrl(databaseUrl as string);
    try {
      execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
          'db',
          'push',
          '--schema',
          SCHEMA,
          '--skip-generate',
          '--force-reset',
        ],
        { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
      );
    } catch (err: any) {
      const output = String(err?.stderr || err?.stdout || err?.message || '');
      throw new Error(
        `prisma db push failed: ${output
          .split(url)
          .join('<url>')
          .slice(0, 600)}`
      );
    }

    process.env.DATABASE_URL = url;
    process.env[YSOCIAL_TOKEN_KEY_ENV] = keyBase64;
    delete process.env.STRIPE_SECRET_KEY;

    const { PrismaClient } = jest.requireActual(
      join(ROOT, 'node_modules', '@prisma', 'client')
    );
    const {
      PrismaService,
      PrismaRepository,
    } = require('@gitroom/nestjs-libraries/database/prisma/prisma.service');
    const {
      IntegrationRepository,
    } = require('@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository');

    prisma = new PrismaService();
    raw = new PrismaClient({ datasources: { db: { url } } });
    repo = (name: string) => new PrismaRepository(prisma) as any;
    integrationRepository = new IntegrationRepository(
      repo('integration'),
      repo('post'),
      repo('plugs'),
      repo('exisingPlugData'),
      repo('customer'),
      repo('mentions')
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all([prisma?.$disconnect(), raw?.$disconnect()]);
    for (const [name, value] of [
      ['DATABASE_URL', saved.DATABASE_URL],
      [YSOCIAL_TOKEN_KEY_ENV, saved.KEY],
      ['STRIPE_SECRET_KEY', saved.STRIPE],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('plain client calls', () => {
    it('create stores ys1 and returns plaintext', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const created = await prisma.integration.create({ data });
      expect(created.token).toBe(data.token);
      expect(created.refreshToken).toBe(data.refreshToken);
      const row = await stored(created.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
      expect(row.token).not.toContain(data.token);
      const read = await prisma.integration.findUnique({
        where: { id: created.id },
      });
      expect(read.token).toBe(data.token);
      expect(read.refreshToken).toBe(data.refreshToken);
    });

    it('keeps a null refreshToken and encrypts an empty token', async () => {
      const org = await makeOrg();
      const created = await prisma.integration.create({
        data: integrationData(org.id, { token: '', refreshToken: null }),
      });
      expect(created.token).toBe('');
      expect(created.refreshToken).toBeNull();
      const row = await stored(created.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(decryptYsocialToken(row.token, 'token', key)).toBe('');
      expect(row.refreshToken).toBeNull();
    });

    it('update with a string and with { set }', async () => {
      const org = await makeOrg();
      const { id } = await prisma.integration.create({
        data: integrationData(org.id),
      });
      const a = await prisma.integration.update({
        where: { id },
        data: { token: 'updated-token' },
      });
      expect(a.token).toBe('updated-token');
      expect(isCipher((await stored(id)).token, 'token')).toBe(true);
      const b = await prisma.integration.update({
        where: { id },
        data: { refreshToken: { set: 'set-refresh' } },
      });
      expect(b.refreshToken).toBe('set-refresh');
      expect(isCipher((await stored(id)).refreshToken, 'refreshToken')).toBe(
        true
      );
    });

    it('updateMany and createMany store ys1', async () => {
      const org = await makeOrg();
      await prisma.integration.createMany({
        data: [integrationData(org.id), integrationData(org.id)],
      });
      for (const row of await raw.integration.findMany({})) {
        expect(isCipher(row.token, 'token')).toBe(true);
        expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
      }
      await prisma.integration.updateMany({
        where: { organizationId: org.id },
        data: { token: 'same-for-all' },
      });
      const rows = await raw.integration.findMany({});
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(isCipher(row.token, 'token')).toBe(true);
        expect(decryptYsocialToken(row.token, 'token', key)).toBe(
          'same-for-all'
        );
      }
    });

    it('createManyAndReturn returns plaintext', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const rows = await prisma.integration.createManyAndReturn({
        data: [data],
      });
      expect(rows[0].token).toBe(data.token);
      expect(isCipher((await stored(rows[0].id)).token, 'token')).toBe(true);
    });

    it('upsert stores ys1 on create and on update', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const where = {
        organizationId_internalId: {
          organizationId: org.id,
          internalId: data.internalId,
        },
      };
      const first = await prisma.integration.upsert({
        where,
        create: data,
        update: { token: 'never' },
      });
      expect(first.token).toBe(data.token);
      expect(isCipher((await stored(first.id)).token, 'token')).toBe(true);
      const second = await prisma.integration.upsert({
        where,
        create: data,
        update: { token: 'second-token', refreshToken: 'second-refresh' },
      });
      expect(second.id).toBe(first.id);
      expect(second.token).toBe('second-token');
      const row = await stored(first.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(decryptYsocialToken(row.refreshToken!, 'refreshToken', key)).toBe(
        'second-refresh'
      );
    });
  });

  describe('reads through relations', () => {
    it('decrypts post.include.integration, select and to-many lists', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const integration = await prisma.integration.create({ data });
      const post = await prisma.post.create({
        data: {
          organizationId: org.id,
          integrationId: integration.id,
          content: 'c',
          group: 'g',
          publishDate: new Date(),
        },
      });

      const included = await prisma.post.findUnique({
        where: { id: post.id },
        include: { integration: true },
      });
      expect(included.integration.token).toBe(data.token);
      expect(included.integration.refreshToken).toBe(data.refreshToken);

      const selected = await prisma.post.findUnique({
        where: { id: post.id },
        select: {
          integration: { select: { token: true, refreshToken: true } },
        },
      });
      expect(selected.integration.token).toBe(data.token);
      expect(selected.integration.refreshToken).toBe(data.refreshToken);

      const toMany = await prisma.organization.findUnique({
        where: { id: org.id },
        include: { Integration: true },
      });
      expect(toMany.Integration[0].token).toBe(data.token);

      const viaCustomer = await prisma.customer.create({
        data: {
          name: unique('c'),
          orgId: org.id,
          integrations: { connect: { id: integration.id } },
        },
        include: { integrations: true },
      });
      expect(viaCustomer.integrations[0].token).toBe(data.token);
    });

    it('reads a plaintext row that was created without the extension', async () => {
      const org = await makeOrg();
      const row = await raw.integration.create({
        data: integrationData(org.id, {
          token: 'old-plain',
          refreshToken: 'old-plain-r',
        }),
      });
      const read = await prisma.integration.findUnique({
        where: { id: row.id },
      });
      expect(read.token).toBe('old-plain');
      expect(read.refreshToken).toBe('old-plain-r');
    });

    it('filters on the stored value (where is not changed)', async () => {
      const org = await makeOrg();
      const row = await raw.integration.create({
        data: integrationData(org.id, { token: 'find-me' }),
      });
      const found = await prisma.integration.findFirst({
        where: { token: 'find-me' },
      });
      expect(found.id).toBe(row.id);
    });
  });

  describe('nested writes', () => {
    it('Organization.Integration create and update store ys1', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const { organizationId, ...nested } = data;
      await prisma.organization.update({
        where: { id: org.id },
        data: { Integration: { create: nested } },
      });
      const created = await raw.integration.findFirst({
        where: { organizationId: org.id },
      });
      expect(isCipher(created.token, 'token')).toBe(true);
      expect(decryptYsocialToken(created.token, 'token', key)).toBe(data.token);

      await prisma.organization.update({
        where: { id: org.id },
        data: {
          Integration: {
            update: {
              where: { id: created.id },
              data: { token: 'nested-updated' },
            },
          },
        },
      });
      const updated = await stored(created.id);
      expect(isCipher(updated.token, 'token')).toBe(true);
      expect(decryptYsocialToken(updated.token, 'token', key)).toBe(
        'nested-updated'
      );
    });

    it('Customer.integrations create stores ys1', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const customer = await prisma.customer.create({
        data: {
          name: unique('c'),
          orgId: org.id,
          integrations: { create: data },
        },
        include: { integrations: true },
      });
      expect(customer.integrations[0].token).toBe(data.token);
      const row = await stored(customer.integrations[0].id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
    });
  });

  describe('transactions', () => {
    it('interactive transaction', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const created = await prisma.$transaction(async (tx: any) => {
        const row = await tx.integration.create({ data });
        return tx.integration.update({
          where: { id: row.id },
          data: { token: 'in-tx' },
        });
      });
      expect(created.token).toBe('in-tx');
      const row = await stored(created.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
    });

    it('batch transaction', async () => {
      const org = await makeOrg();
      const data = integrationData(org.id);
      const [created] = await prisma.$transaction([
        prisma.integration.create({ data }),
        prisma.integration.updateMany({
          where: { organizationId: org.id },
          data: { disabled: true },
        }),
      ]);
      expect(created.token).toBe(data.token);
      expect(isCipher((await stored(created.id)).token, 'token')).toBe(true);
    });
  });

  describe('data model', () => {
    it('relations to Integration in the client are those of schema.prisma', () => {
      const runtime = Object.entries(
        (prisma as any)._runtimeDataModel.models as Record<
          string,
          { fields: { name: string; kind: string; type: string }[] }
        >
      )
        .flatMap(([model, { fields }]) =>
          fields
            .filter((f) => f.kind === 'object' && f.type === 'Integration')
            .map((f) => `${model}.${f.name}`)
        )
        .sort();
      const expected = schemaRelationsToIntegration();
      expect(expected.length).toBeGreaterThan(0);
      expect(runtime).toEqual(expected);
    });
  });

  describe('migration', () => {
    const buildService = (integration: any) => {
      const {
        YsocialTokenMigrationService,
      } = require('./ysocial.token.migration.service');
      return new YsocialTokenMigrationService({ model: { integration } });
    };

    it('encrypts plaintext, skips encrypted values, and can run twice', async () => {
      const org = await makeOrg();
      const plain = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          raw.integration.create({
            data: integrationData(org.id, {
              token: `plain-${i}`,
              refreshToken: i === 2 ? null : `plain-r-${i}`,
            }),
          })
        )
      );
      const already = await prisma.integration.create({
        data: integrationData(org.id, {
          token: 'already',
          refreshToken: 'already-r',
        }),
      });
      const before = await stored(already.id);

      const result = await buildService(prisma.integration).migrate(2);
      expect(result).toEqual({
        token: { encrypted: 5, changedMeanwhile: 0, remaining: 0 },
        refreshToken: { encrypted: 4, changedMeanwhile: 0, remaining: 0 },
      });

      for (const [i, row] of plain.entries()) {
        const after = await stored(row.id);
        expect(isCipher(after.token, 'token')).toBe(true);
        expect(decryptYsocialToken(after.token, 'token', key)).toBe(
          `plain-${i}`
        );
        if (i === 2) {
          expect(after.refreshToken).toBeNull();
        } else {
          expect(
            decryptYsocialToken(after.refreshToken!, 'refreshToken', key)
          ).toBe(`plain-r-${i}`);
        }
        const read = await prisma.integration.findUnique({
          where: { id: row.id },
        });
        expect(read.token).toBe(`plain-${i}`);
      }
      expect(await stored(already.id)).toEqual(before);

      const again = await buildService(prisma.integration).migrate();
      expect(again.token.encrypted).toBe(0);
      expect(again.refreshToken.encrypted).toBe(0);
    });

    it('leaves a value alone that changed between read and write', async () => {
      const org = await makeOrg();
      await Promise.all(
        ['a', 'b'].map((t) =>
          raw.integration.create({
            data: integrationData(org.id, {
              token: `plain-${t}`,
              refreshToken: null,
            }),
          })
        )
      );
      let interferedId = '';
      const racing = {
        ...prisma.integration,
        findMany: async (args: any) => {
          const found = await prisma.integration.findMany(args);
          if (!interferedId && found.length) {
            interferedId = found[0].id;
            // Postiz refreshes the first row's token in between.
            await prisma.integration.update({
              where: { id: found[0].id },
              data: { token: 'refreshed-by-postiz' },
            });
          }
          return found;
        },
        updateMany: (args: any) => prisma.integration.updateMany(args),
        count: (args: any) => prisma.integration.count(args),
      };

      const result = await buildService(racing).migrate(10);
      expect(result.token.changedMeanwhile).toBe(1);
      expect(result.token.encrypted).toBe(1);

      const changed = await stored(interferedId);
      // The refresh went through the extension, so it is ciphertext already.
      expect(isCipher(changed.token, 'token')).toBe(true);
      expect(decryptYsocialToken(changed.token, 'token', key)).toBe(
        'refreshed-by-postiz'
      );
    });

    it('does not overwrite a plaintext value written in between', async () => {
      const org = await makeOrg();
      const row = await raw.integration.create({
        data: integrationData(org.id, {
          token: 'plain-first',
          refreshToken: null,
        }),
      });
      let interfered = false;
      const racing = {
        findMany: async (args: any) => {
          const found = await prisma.integration.findMany(args);
          if (!interfered && found.length) {
            interfered = true;
            await raw.integration.update({
              where: { id: row.id },
              data: { token: 'plain-second' },
            });
          }
          return found;
        },
        updateMany: (args: any) => prisma.integration.updateMany(args),
        count: (args: any) => prisma.integration.count(args),
      };
      const result = await buildService(racing).migrate();
      expect(result.token.changedMeanwhile).toBe(1);
      expect((await stored(row.id)).token).toBe('plain-second');
      // A second run picks the new plaintext up.
      const again = await buildService(prisma.integration).migrate();
      expect(again.token.encrypted).toBe(1);
      expect(
        decryptYsocialToken((await stored(row.id)).token, 'token', key)
      ).toBe('plain-second');
    });
  });

  describe('YsocialTokenKeyCheck', () => {
    const buildCheck = () => {
      const { YsocialTokenKeyCheck } = require('./ysocial.token.key.check');
      return new YsocialTokenKeyCheck({ model: prisma });
    };

    it('is off without key on a database without ciphertext', async () => {
      const org = await makeOrg();
      await raw.integration.create({ data: integrationData(org.id) });
      expect(await buildCheck().check({})).toEqual({ encryption: 'off' });
    });

    it('is on with the right key, also on an empty database', async () => {
      expect(
        await buildCheck().check({ [YSOCIAL_TOKEN_KEY_ENV]: keyBase64 })
      ).toEqual({
        encryption: 'on',
        kid: key.kid,
      });
      const org = await makeOrg();
      await prisma.integration.create({ data: integrationData(org.id) });
      expect(
        await buildCheck().check({ [YSOCIAL_TOKEN_KEY_ENV]: keyBase64 })
      ).toEqual({
        encryption: 'on',
        kid: key.kid,
      });
    });

    it('fails with a wrong key, naming both key ids', async () => {
      const org = await makeOrg();
      await prisma.integration.create({ data: integrationData(org.id) });
      const other = newKeyBase64();
      const otherKey = readYsocialTokenKey({ [YSOCIAL_TOKEN_KEY_ENV]: other })!;
      // In Postiz the extension and the check read the same key from the
      // environment, so the check runs on a client with the other key.
      const { YsocialTokenKeyCheck } = require('./ysocial.token.key.check');
      const {
        withYsocialTokenEncryption,
      } = require('./ysocial.token.extension');
      const otherClient = withYsocialTokenEncryption(raw, {
        [YSOCIAL_TOKEN_KEY_ENV]: other,
      });
      const error = await new YsocialTokenKeyCheck({ model: otherClient })
        .check({ [YSOCIAL_TOKEN_KEY_ENV]: other })
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect(error.message).toContain(otherKey.kid);
      expect(error.message).toContain(key.kid);
      expect((error as YsocialTokenKeyError).storedKid).toBe(key.kid);
      expect(error.message).not.toContain(other);
      expect(error.message).not.toContain(keyBase64);
    });

    it('fails without a key once ciphertext exists', async () => {
      const org = await makeOrg();
      await prisma.integration.create({ data: integrationData(org.id) });
      const error = await buildCheck()
        .check({})
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect(error.message).toContain(YSOCIAL_TOKEN_KEY_ENV);
    });

    it('fails when a value was changed (probe cannot decrypt)', async () => {
      const org = await makeOrg();
      const row = await prisma.integration.create({
        data: integrationData(org.id),
      });
      const parts = (await stored(row.id)).token.split(':');
      parts[4] = Buffer.from('tampered').toString('base64url');
      await raw.integration.update({
        where: { id: row.id },
        data: { token: parts.join(':') },
      });
      await expect(
        buildCheck().check({ [YSOCIAL_TOKEN_KEY_ENV]: keyBase64 })
      ).rejects.toBeInstanceOf(YsocialTokenKeyError);
    });
  });

  describe('Postiz paths', () => {
    it('a) connecting a channel stores ys1', async () => {
      const org = await makeOrg();
      const created = await integrationRepository.createOrUpdateIntegration(
        undefined,
        false,
        org.id,
        'Channel',
        undefined,
        'social',
        'internal-a',
        'x',
        'access-token-a',
        'refresh-token-a',
        3600
      );
      const row = await stored(created.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
      expect(row.token).not.toContain('access-token-a');
      expect(created.token).toBe('access-token-a');

      // connecting again updates the stored values, an empty refresh token
      // does not wipe the old one
      await integrationRepository.createOrUpdateIntegration(
        undefined,
        false,
        org.id,
        'Channel',
        undefined,
        'social',
        'internal-a',
        'x',
        'access-token-b'
      );
      const after = await stored(created.id);
      expect(decryptYsocialToken(after.token, 'token', key)).toBe(
        'access-token-b'
      );
      expect(
        decryptYsocialToken(after.refreshToken!, 'refreshToken', key)
      ).toBe('refresh-token-a');
    });

    it('b) a token refresh gives the provider the plain refreshToken and stores the new one encrypted', async () => {
      const {
        RefreshIntegrationService,
      } = require('@gitroom/nestjs-libraries/integrations/refresh.integration.service');
      const org = await makeOrg();
      const created = await integrationRepository.createOrUpdateIntegration(
        undefined,
        false,
        org.id,
        'Channel',
        undefined,
        'social',
        'internal-b',
        'x',
        'old-access',
        'old-refresh',
        3600
      );
      const integration = await integrationRepository.getIntegrationById(
        org.id,
        created.id
      );

      const provider = {
        oneTimeToken: false,
        refreshToken: jest.fn(async () => ({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresIn: 3600,
          id: 'internal-b',
          name: 'Channel',
          picture: '',
          username: 'u',
        })),
      };
      const manager = { getSocialIntegration: jest.fn(() => provider) };
      const integrationService = {
        createOrUpdateIntegration: (...args: any[]) =>
          integrationRepository.createOrUpdateIntegration(...args),
        refreshNeeded: jest.fn(),
        informAboutRefreshError: jest.fn(),
      };
      const service = new RefreshIntegrationService(
        manager as any,
        integrationService as any,
        {} as any
      );

      const result = await service.refresh(integration);
      expect(result).toMatchObject({ accessToken: 'new-access' });
      expect(provider.refreshToken).toHaveBeenCalledWith('old-refresh');
      expect(integrationService.refreshNeeded).not.toHaveBeenCalled();

      const row = await stored(created.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(decryptYsocialToken(row.token, 'token', key)).toBe('new-access');
      expect(decryptYsocialToken(row.refreshToken!, 'refreshToken', key)).toBe(
        'new-refresh'
      );
      expect(row.token).not.toContain('new-access');
    });

    it('c) the post path hands the plain token to the provider', async () => {
      const {
        PostsRepository,
      } = require('@gitroom/nestjs-libraries/database/prisma/posts/posts.repository');
      const {
        PostsService,
      } = require('@gitroom/nestjs-libraries/database/prisma/posts/posts.service');
      const {
        PostActivity,
      } = require('../../../../apps/orchestrator/src/activities/post.activity');

      const org = await makeOrg();
      const created = await integrationRepository.createOrUpdateIntegration(
        undefined,
        false,
        org.id,
        'Channel',
        undefined,
        'social',
        'internal-c',
        'x',
        'publish-token',
        'publish-refresh',
        3600
      );
      const post = await prisma.post.create({
        data: {
          organizationId: org.id,
          integrationId: created.id,
          content: '<p>hello</p>',
          group: 'g',
          publishDate: new Date(),
        },
      });
      expect(isCipher((await stored(created.id)).token, 'token')).toBe(true);

      const provider = {
        editor: 'normal',
        mentionFormat: undefined as string | undefined,
        post: jest.fn(async () => [
          {
            id: post.id,
            postId: 'platform-id',
            releaseURL: 'https://x.test/1',
            status: 'completed',
          },
        ]),
      };
      const manager = { getSocialIntegration: jest.fn(() => provider) };
      const postsRepository = new PostsRepository(
        repo('post'),
        repo('popularPosts'),
        repo('comments'),
        repo('tags'),
        repo('tagsPosts'),
        repo('errors')
      );
      const postsService = new PostsService(
        postsRepository,
        manager,
        {},
        { getMediaById: jest.fn() },
        {},
        {},
        {},
        {}
      );
      const rawWorkflow = { start: jest.fn(async () => undefined) };
      const temporal = {
        client: { getRawClient: () => ({ workflow: rawWorkflow }) },
      };
      const activity = new PostActivity(
        postsService,
        {},
        manager,
        {},
        {},
        {},
        temporal,
        {}
      );

      const loaded = await activity.getPost(org.id, post.id);
      expect(loaded.integration.token).toBe('publish-token');
      expect(loaded.integration.refreshToken).toBe('publish-refresh');

      const list = await activity.getPostsList(org.id, post.id);
      expect(list[0].integration.token).toBe('publish-token');

      await activity.postSocial(loaded.integration, [loaded]);
      expect(provider.post).toHaveBeenCalledTimes(1);
      const call = provider.post.mock.calls[0] as unknown as any[];
      expect(call[0]).toBe('internal-c');
      expect(call[1]).toBe('publish-token');
      expect(call[3].token).toBe('publish-token');
      expect(JSON.stringify(call)).not.toContain('ys1:');

      // the stored value stays encrypted
      expect((await stored(created.id)).token.startsWith('ys1:')).toBe(true);
    });

    it('d) the channel list and lookup by id return plaintext', async () => {
      const org = await makeOrg();
      await integrationRepository.createOrUpdateIntegration(
        undefined,
        false,
        org.id,
        'Channel',
        undefined,
        'social',
        'internal-d',
        'x',
        'list-token',
        'list-refresh',
        3600
      );
      const list = await integrationRepository.getIntegrationsList(org.id);
      expect(list).toHaveLength(1);
      expect(list[0].token).toBe('list-token');
      expect(list[0].refreshToken).toBe('list-refresh');

      const byId = await integrationRepository.getIntegrationById(
        org.id,
        list[0].id
      );
      expect(byId.token).toBe('list-token');
    });

    const connect = (
      org: string,
      internalId: string,
      token: string,
      refresh: string,
      oneTime = false
    ) =>
      integrationRepository.createOrUpdateIntegration(
        undefined,
        oneTime,
        org,
        'Channel',
        undefined,
        'social',
        internalId,
        'x',
        token,
        refresh,
        3600
      );

    it('e) picking a page (updateIntegration) stores ys1', async () => {
      const org = await makeOrg();
      const login = await connect(
        org.id,
        'login-e',
        'login-token',
        'login-refresh'
      );

      // No row with the page's internalId yet: the login row becomes the page.
      await integrationRepository.updateIntegration(login.id, {
        internalId: 'page-e',
        organizationId: org.id,
        name: 'Page',
        inBetweenSteps: false,
        token: 'page-token',
        profile: 'page',
      });
      const row = await stored(login.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
      expect(decryptYsocialToken(row.token, 'token', key)).toBe('page-token');
      expect(decryptYsocialToken(row.refreshToken!, 'refreshToken', key)).toBe(
        'login-refresh'
      );
      const read = await integrationRepository.getIntegrationById(
        org.id,
        login.id
      );
      expect(read.token).toBe('page-token');
      expect(read.refreshToken).toBe('login-refresh');
    });

    it('e) picking a page that already has a row copies the plain refreshToken and stores ys1', async () => {
      const org = await makeOrg();
      const existing = await connect(
        org.id,
        'page-e2',
        'old-page-token',
        'old-page-refresh'
      );
      const login = await connect(
        org.id,
        'login-e2',
        'login-token',
        'fresh-refresh'
      );

      await integrationRepository.updateIntegration(login.id, {
        internalId: 'page-e2',
        organizationId: org.id,
        name: 'Page',
        inBetweenSteps: false,
        token: 'page-token',
        profile: 'page',
      });

      const row = await stored(existing.id);
      expect(isCipher(row.token, 'token')).toBe(true);
      expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
      expect(decryptYsocialToken(row.token, 'token', key)).toBe('page-token');
      // copied from the login row, which prisma returned as plaintext
      expect(decryptYsocialToken(row.refreshToken!, 'refreshToken', key)).toBe(
        'fresh-refresh'
      );
      expect(row.refreshToken).not.toContain('fresh-refresh');
      const read = await integrationRepository.getIntegrationById(
        org.id,
        existing.id
      );
      expect(read.token).toBe('page-token');
      expect(read.refreshToken).toBe('fresh-refresh');

      // the login row was moved out of the way and is still encrypted
      const old = await stored(login.id);
      expect(isCipher(old.token, 'token')).toBe(true);
      expect(isCipher(old.refreshToken, 'refreshToken')).toBe(true);
    });

    it('f) a one time token writes ys1 to all rows of the same root', async () => {
      const org = await makeOrg();
      const root = await connect(
        org.id,
        'root-f',
        'first-token',
        'first-refresh'
      );
      const sibling = await prisma.integration.create({
        data: integrationData(org.id, {
          internalId: 'sibling-f',
          rootInternalId: 'root-f',
          token: 'sibling-token',
          refreshToken: 'sibling-refresh',
        }),
      });
      const other = await prisma.integration.create({
        data: integrationData(org.id, {
          rootInternalId: 'unrelated',
          token: 'other-token',
        }),
      });

      await connect(org.id, 'root-f', 'shared-token', 'shared-refresh', true);

      for (const id of [root.id, sibling.id]) {
        const row = await stored(id);
        expect(isCipher(row.token, 'token')).toBe(true);
        expect(isCipher(row.refreshToken, 'refreshToken')).toBe(true);
        expect(decryptYsocialToken(row.token, 'token', key)).toBe(
          'shared-token'
        );
        expect(
          decryptYsocialToken(row.refreshToken!, 'refreshToken', key)
        ).toBe('shared-refresh');
        const read = await integrationRepository.getIntegrationById(org.id, id);
        expect(read.token).toBe('shared-token');
        expect(read.refreshToken).toBe('shared-refresh');
      }
      const untouched = await prisma.integration.findUnique({
        where: { id: other.id },
      });
      expect(untouched.token).toBe('other-token');
    });
  });
});
