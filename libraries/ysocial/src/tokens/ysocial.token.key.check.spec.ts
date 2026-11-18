import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  encryptYsocialToken,
  readYsocialTokenKey,
  YSOCIAL_TOKEN_KEY_ENV,
  YsocialTokenKey,
  YsocialTokenKeyError,
} from './token.crypto';
import {
  POSTIZ_ENCRYPTION_ENV,
  POSTIZ_TOKEN_PREFIX,
  YsocialTokenKeyCheck,
  ysocialTokenKeyCheckProvider,
} from './ysocial.token.key.check';

const newKeyBase64 = () => randomBytes(32).toString('base64');
const keyOf = (base64: string) =>
  readYsocialTokenKey({ [YSOCIAL_TOKEN_KEY_ENV]: base64 }) as YsocialTokenKey;

const startsWithOf = (filter: any) => {
  const field = Object.keys(filter)[0];
  return { field, prefix: filter[field].startsWith as string };
};

// Field and own prefix of a "foreign ciphertext" filter:
// { AND: [{ f: { startsWith: 'ys1:' } }, { NOT: { f: { startsWith: own } } }] }
const foreignOf = (where: any) => {
  const [all, not] = where.AND;
  return {
    field: startsWithOf(all).field,
    allPrefix: startsWithOf(all).prefix,
    ownPrefix: startsWithOf(not.NOT).prefix,
  };
};

// count answers the filter for foreign values by field, the OR filter for
// Postiz ciphertext (enc:v1:) by postizCount and the one for the state
// without key (ys1:) by orCount.
const build = (opts: {
  foreign?: (filter: { field: string; ownPrefix: string }) => number;
  postizCount?: number;
  orCount?: number;
  probe?: unknown;
  rows?: unknown[];
  foreignProbe?: unknown;
}) => {
  const integration = {
    count: jest.fn(async ({ where }: any) =>
      where.OR
        ? startsWithOf(where.OR[0]).prefix === POSTIZ_TOKEN_PREFIX
          ? opts.postizCount ?? 0
          : opts.orCount ?? 0
        : opts.foreign?.(foreignOf(where)) ?? 0
    ),
    findFirst: jest.fn(async () => opts.foreignProbe ?? null),
    // Every row with the own key; probe is a shortcut for one row.
    findMany: jest.fn(
      async () => opts.rows ?? (opts.probe ? [opts.probe] : [])
    ),
  };
  const check = new YsocialTokenKeyCheck({ model: { integration } } as any);
  return { check, integration };
};

describe('YsocialTokenKeyCheck.check', () => {
  it('is off without key and without ciphertext', async () => {
    const { check, integration } = build({ orCount: 0 });
    expect(await check.check({})).toEqual({ encryption: 'off' });
    expect(integration.count.mock.calls[0][0].where.OR).toEqual([
      { token: { startsWith: 'enc:v1:' } },
      { refreshToken: { startsWith: 'enc:v1:' } },
    ]);
    const where = integration.count.mock.calls[1][0].where;
    expect(where.OR).toEqual([
      { token: { startsWith: 'ys1:' } },
      { refreshToken: { startsWith: 'ys1:' } },
    ]);
    expect(integration.findFirst).not.toHaveBeenCalled();
  });

  it('fails without key when ciphertext exists, with the count only', async () => {
    const { check } = build({ orCount: 3 });
    const error = await check.check({}).catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(error.message).toContain(YSOCIAL_TOKEN_KEY_ENV);
    expect(error.message).toContain('3');
  });

  it('is on when no value carries another key, with one count per field', async () => {
    const base64 = newKeyBase64();
    const key = keyOf(base64);
    const { check, integration } = build({});
    expect(await check.check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })).toEqual({
      encryption: 'on',
      kid: key.kid,
    });
    // The first count is the one for enc:v1:, then one per field.
    const filters = integration.count.mock.calls
      .slice(1)
      .map(([arg]: any) => foreignOf(arg.where));
    expect(filters).toEqual([
      { field: 'token', allPrefix: 'ys1:', ownPrefix: `ys1:${key.kid}:` },
      {
        field: 'refreshToken',
        allPrefix: 'ys1:',
        ownPrefix: `ys1:${key.kid}:`,
      },
    ]);
  });

  it('is on with no ciphertext at all, probing once', async () => {
    const base64 = newKeyBase64();
    const { check, integration } = build({});
    expect(
      (await check.check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })).encryption
    ).toBe('on');
    expect(integration.findMany).toHaveBeenCalledTimes(1);
    expect(integration.findFirst).not.toHaveBeenCalled();
  });

  it('starts while own ciphertext appears during the check', async () => {
    // The count is only about foreign values: own values written by Postiz
    // or the migration in between do not change it.
    const base64 = newKeyBase64();
    const { check } = build({
      foreign: () => 0,
      probe: { token: 'x', refreshToken: null as string | null },
    });
    await expect(
      check.check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })
    ).resolves.toMatchObject({ encryption: 'on' });
  });

  it('fails for a foreign kid with count, field and own kid, no token', async () => {
    const base64 = newKeyBase64();
    const key = keyOf(base64);
    const { check } = build({
      foreign: ({ field }) => (field === 'token' ? 0 : 2),
    });
    const error = await check
      .check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })
      .catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(error.message).toContain(key.kid);
    expect(error.message).toContain('2');
    expect(error.message).toContain('refreshToken');
    expect(error.message).toContain('unbekannt');
    expect(error.message).not.toContain(base64);
  });

  it('names the stored kid that the probe of a foreign value reports', async () => {
    const base64 = newKeyBase64();
    const key = keyOf(base64);
    const foreignProbe = {
      get token(): string {
        throw new YsocialTokenKeyError('foreign', 'abcd1234');
      },
      refreshToken: null as string | null,
    };
    const { check, integration } = build({
      foreign: ({ field }) => (field === 'token' ? 2 : 0),
      foreignProbe,
    });
    const error = await check
      .check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })
      .catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(error.storedKid).toBe('abcd1234');
    expect(error.message).toContain('abcd1234');
    expect(error.message).toContain(key.kid);
    const call = (integration.findFirst.mock.calls as any[][])[0][0];
    expect(call.where).toEqual({
      AND: [
        { token: { startsWith: 'ys1:' } },
        { NOT: { token: { startsWith: `ys1:${key.kid}:` } } },
      ],
    });
  });

  it('fails for an invalid key before touching the database', async () => {
    const { check, integration } = build({});
    const error = await check
      .check({ [YSOCIAL_TOKEN_KEY_ENV]: randomBytes(16).toString('base64') })
      .catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(integration.count).not.toHaveBeenCalled();
  });

  it('probes one row with the own kid and decrypts it by access', async () => {
    const base64 = newKeyBase64();
    const key = keyOf(base64);
    const probe = { token: 'x', refreshToken: null as string | null };
    const { check, integration } = build({ probe });
    await check.check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 });
    const args = integration.findMany.mock.calls[0] as any;
    expect(args[0].where.OR).toEqual([
      { token: { startsWith: `ys1:${key.kid}:` } },
      { refreshToken: { startsWith: `ys1:${key.kid}:` } },
    ]);
    expect(args[0].select).toEqual({ token: true, refreshToken: true });
  });

  it('fails when the probe cannot be decrypted (changed value)', async () => {
    const base64 = newKeyBase64();
    const probe = {
      get token(): string {
        throw new YsocialTokenKeyError(
          'Kanal-Token (token) verändert oder beschädigt'
        );
      },
      refreshToken: null as string | null,
    };
    const { check } = build({ probe });
    await expect(
      check.check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })
    ).rejects.toBeInstanceOf(YsocialTokenKeyError);
  });
});

describe('YsocialTokenKeyCheck.check, token encryption of Postiz', () => {
  const POSTIZ_VALUE = `${POSTIZ_TOKEN_PREFIX}tok-secret-value`;

  it('exports the env name and the prefix of Postiz', () => {
    expect(POSTIZ_ENCRYPTION_ENV).toBe('ENCRYPTION_PROVIDER');
    expect(POSTIZ_TOKEN_PREFIX).toBe('enc:v1:');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['spaces', '   '],
    ['tab and newline', ' \t\n '],
  ])('treats %s ENCRYPTION_PROVIDER as not set', async (_name, value) => {
    const { check } = build({});
    await expect(
      check.check({ [POSTIZ_ENCRYPTION_ENV]: value })
    ).resolves.toEqual({ encryption: 'off' });
  });

  it.each(['local', 'aws-kms', 'x', ' local '])(
    'fails for ENCRYPTION_PROVIDER=%j before touching the database',
    async (value) => {
      const { check, integration } = build({});
      const error = await check
        .check({
          [POSTIZ_ENCRYPTION_ENV]: value,
        })
        .catch((err) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect(error.message).toContain(POSTIZ_ENCRYPTION_ENV);
      expect(integration.count).not.toHaveBeenCalled();
      expect(integration.findFirst).not.toHaveBeenCalled();
    }
  );

  it('fails with a key too, when ENCRYPTION_PROVIDER is set', async () => {
    const { check } = build({});
    const error = await check
      .check({
        [POSTIZ_ENCRYPTION_ENV]: 'local',
        [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64(),
      })
      .catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(error.message).toContain(POSTIZ_ENCRYPTION_ENV);
  });

  it('counts enc:v1: in token and in refreshToken with one OR, before the own key is considered', async () => {
    const { check, integration } = build({ postizCount: 4 });
    const error = await check.check({}).catch((err) => err);
    expect(error).toBeInstanceOf(YsocialTokenKeyError);
    expect(integration.count).toHaveBeenCalledTimes(1);
    expect(integration.count.mock.calls[0][0].where).toEqual({
      OR: [
        { token: { startsWith: 'enc:v1:' } },
        { refreshToken: { startsWith: 'enc:v1:' } },
      ],
    });
    expect(error.message).toContain('4');
    expect(error.message).toContain(POSTIZ_TOKEN_PREFIX);
  });

  it('fails on enc:v1: with a valid key as well, without the other queries', async () => {
    const { check, integration } = build({ postizCount: 1 });
    await expect(
      check.check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
    ).rejects.toBeInstanceOf(YsocialTokenKeyError);
    expect(integration.count).toHaveBeenCalledTimes(1);
    expect(integration.findFirst).not.toHaveBeenCalled();
    expect(integration.findMany).not.toHaveBeenCalled();
  });

  it.each(['token', 'refreshToken'])(
    'fails when only %s carries enc:v1:',
    async (field) => {
      // The mock answers by the filter: only the one OR entry for the field
      // would match in the database.
      const integration = {
        count: jest.fn(async ({ where }: any) =>
          where.OR.some(
            (entry: any) => entry[field]?.startsWith === POSTIZ_TOKEN_PREFIX
          )
            ? 1
            : 0
        ),
        findFirst: jest.fn(),
      };
      const check = new YsocialTokenKeyCheck({
        model: { integration },
      } as any);
      await expect(check.check({})).rejects.toBeInstanceOf(
        YsocialTokenKeyError
      );
    }
  );

  it.each(['token', 'refreshToken'])(
    'fails when the probe has our ys1: around enc:v1: in %s',
    async (field) => {
      const base64 = newKeyBase64();
      const probe = { token: 'x', refreshToken: null as string | null } as any;
      probe[field] = POSTIZ_VALUE;
      const { check } = build({ probe });
      const error = await check
        .check({ [YSOCIAL_TOKEN_KEY_ENV]: base64 })
        .catch((err) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect(error.message).toContain(POSTIZ_TOKEN_PREFIX);
      expect(error.message).toContain(YSOCIAL_TOKEN_KEY_ENV);
    }
  );

  it.each([1, 2])(
    'fails when only row %i of the own-key rows has enc:v1: inside, with the count',
    async (index) => {
      const rows: any[] = [
        { token: 'a', refreshToken: null },
        { token: 'b', refreshToken: 'c' },
        { token: 'd', refreshToken: null },
      ];
      rows[index].refreshToken = POSTIZ_VALUE;
      const { check } = build({ rows });
      const error = await check
        .check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
        .catch((err) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect(error.message).toContain('1 Kanäle');
      expect(error.message).toContain(POSTIZ_TOKEN_PREFIX);
      expect(error.message).not.toContain('tok-secret-value');
    }
  );

  it('counts every row that has enc:v1: inside', async () => {
    const { check } = build({
      rows: [
        { token: POSTIZ_VALUE, refreshToken: null },
        { token: 'ok', refreshToken: null },
        { token: 'x', refreshToken: POSTIZ_VALUE },
        { token: POSTIZ_VALUE, refreshToken: POSTIZ_VALUE },
      ],
    });
    const error = await check
      .check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
      .catch((err) => err);
    expect(error.message).toContain('3 Kanäle');
  });

  it('fails when a later row cannot be decrypted (changed value)', async () => {
    const changed = {
      get token(): string {
        throw new YsocialTokenKeyError('verändert');
      },
      refreshToken: null as string | null,
    };
    const { check } = build({
      rows: [{ token: 'a', refreshToken: null }, changed],
    });
    await expect(
      check.check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
    ).rejects.toBeInstanceOf(YsocialTokenKeyError);
  });

  it('names the action in the messages (partial text only)', async () => {
    const wrapped = await build({
      rows: [{ token: POSTIZ_VALUE, refreshToken: null }],
    })
      .check.check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
      .catch((err) => err);
    const stored = await build({ postizCount: 1 })
      .check.check({})
      .catch((err) => err);
    for (const error of [wrapped, stored]) {
      expect(error.message).toContain('neu verbinden');
      expect(error.message).toContain(POSTIZ_ENCRYPTION_ENV);
    }
  });

  it('passes a probe that does not start with enc:v1:', async () => {
    const { check } = build({
      probe: { token: 'plain enc:v1: inside', refreshToken: null },
    });
    await expect(
      check.check({ [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
    ).resolves.toMatchObject({ encryption: 'on' });
  });

  it('puts no token value or key into any message', async () => {
    const base64 = newKeyBase64();
    const messages: string[] = [];
    const collect = async (
      env: Record<string, string | undefined>,
      opts: Parameters<typeof build>[0]
    ) => {
      const error = await build(opts)
        .check.check(env)
        .catch((err) => err);
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      messages.push(error.message);
    };
    await collect({ [POSTIZ_ENCRYPTION_ENV]: 'local' }, {});
    await collect({}, { postizCount: 2 });
    await collect(
      { [YSOCIAL_TOKEN_KEY_ENV]: base64 },
      { probe: { token: POSTIZ_VALUE, refreshToken: null } }
    );
    for (const message of messages) {
      expect(message).not.toContain('tok-secret-value');
      expect(message).not.toContain(POSTIZ_VALUE);
      expect(message).not.toContain(base64);
    }
  });
});

describe('YsocialTokenKeyCheck.run', () => {
  const saved = process.env[YSOCIAL_TOKEN_KEY_ENV];
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const method of ['log', 'error', 'warn'] as const) {
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: any[]) => {
          logs.push(String(args[0]));
        });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) {
      delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    } else {
      process.env[YSOCIAL_TOKEN_KEY_ENV] = saved;
    }
  });

  it('logs the key id on start, never the key', async () => {
    const base64 = newKeyBase64();
    process.env[YSOCIAL_TOKEN_KEY_ENV] = base64;
    const { check } = build({});
    await check.run();
    expect(logs.join('\n')).toContain(keyOf(base64).kid);
    expect(logs.join('\n')).not.toContain(base64);
  });

  it('logs that encryption is off without a key', async () => {
    delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    const { check } = build({});
    await check.run();
    expect(logs.join('\n')).toMatch(/encryption off/);
  });

  it('logs the failure without a value and rethrows', async () => {
    const base64 = newKeyBase64();
    process.env[YSOCIAL_TOKEN_KEY_ENV] = base64;
    const secret = encryptYsocialToken(
      'tok-secret-value',
      'token',
      keyOf(newKeyBase64())
    );
    const { check } = build({
      foreign: () => 1,
    });
    await expect(check.run()).rejects.toBeInstanceOf(YsocialTokenKeyError);
    const text = logs.join('\n');
    expect(text).toMatch(/token key check failed/);
    expect(text).not.toContain(base64);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('tok-secret-value');
  });

  it('logs the Postiz encryption failure with prefix and rethrows, without a value', async () => {
    delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    const { check } = build({ postizCount: 2 });
    await expect(check.run()).rejects.toBeInstanceOf(YsocialTokenKeyError);
    const text = logs.join('\n');
    expect(text).toMatch(/^token key check failed: /);
    expect(text).toContain(POSTIZ_TOKEN_PREFIX);
    expect(text).toContain('2');
  });

  it('logs the ENCRYPTION_PROVIDER failure and rethrows', async () => {
    delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    const savedProvider = process.env[POSTIZ_ENCRYPTION_ENV];
    process.env[POSTIZ_ENCRYPTION_ENV] = 'aws-kms';
    try {
      const { check } = build({});
      await expect(check.run()).rejects.toBeInstanceOf(YsocialTokenKeyError);
      expect(logs.join('\n')).toMatch(
        new RegExp(`token key check failed: .*${POSTIZ_ENCRYPTION_ENV}`)
      );
      expect(logs.join('\n')).not.toContain('aws-kms');
    } finally {
      if (savedProvider === undefined) {
        delete process.env[POSTIZ_ENCRYPTION_ENV];
      } else {
        process.env[POSTIZ_ENCRYPTION_ENV] = savedProvider;
      }
    }
  });

  it('rethrows a database error without logging it as key error', async () => {
    delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    const boom = new Error('database down');
    const check = new YsocialTokenKeyCheck({
      model: { integration: { count: jest.fn().mockRejectedValue(boom) } },
    } as any);
    await expect(check.run()).rejects.toBe(boom);
    expect(logs.join('\n')).not.toMatch(/token key check failed/);
  });
});

describe('ysocialTokenKeyCheckProvider', () => {
  const saved = process.env[YSOCIAL_TOKEN_KEY_ENV];
  const base64 = newKeyBase64();

  const repository = (foreignCount: number) => ({
    model: {
      integration: {
        count: jest.fn(async () => foreignCount),
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    },
  });

  beforeEach(() => {
    process.env[YSOCIAL_TOKEN_KEY_ENV] = base64;
    for (const method of ['log', 'error', 'warn'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) {
      delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    } else {
      process.env[YSOCIAL_TOKEN_KEY_ENV] = saved;
    }
  });

  it('provides YsocialTokenKeyCheck from PrismaRepository', () => {
    expect(ysocialTokenKeyCheckProvider.provide).toBe(YsocialTokenKeyCheck);
    expect((ysocialTokenKeyCheckProvider as any).inject).toEqual([
      PrismaRepository,
    ]);
  });

  it('the factory resolves with an instance when the check passes', async () => {
    const factory = (ysocialTokenKeyCheckProvider as any).useFactory;
    const instance = await factory(repository(0));
    expect(instance).toBeInstanceOf(YsocialTokenKeyCheck);
  });

  it('the factory rejects with the key error when the check fails', async () => {
    const factory = (ysocialTokenKeyCheckProvider as any).useFactory;
    await expect(factory(repository(2))).rejects.toBeInstanceOf(
      YsocialTokenKeyError
    );
  });

  it('a Nest module compiles with a matching repository', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ysocialTokenKeyCheckProvider,
        { provide: PrismaRepository, useValue: repository(0) },
      ],
    }).compile();
    expect(moduleRef.get(YsocialTokenKeyCheck)).toBeInstanceOf(
      YsocialTokenKeyCheck
    );
  });

  it('a Nest module refuses to compile with a foreign ciphertext', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          ysocialTokenKeyCheckProvider,
          { provide: PrismaRepository, useValue: repository(1) },
        ],
      }).compile()
    ).rejects.toBeInstanceOf(YsocialTokenKeyError);
  });
});
