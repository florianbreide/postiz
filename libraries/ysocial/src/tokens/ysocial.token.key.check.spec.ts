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

// count answers the filter for foreign values by field, the one for the
// state without key by orCount.
const build = (opts: {
  foreign?: (filter: { field: string; ownPrefix: string }) => number;
  orCount?: number;
  probe?: unknown;
  foreignProbe?: unknown;
}) => {
  const integration = {
    count: jest.fn(async ({ where }: any) =>
      where.OR ? opts.orCount ?? 0 : opts.foreign?.(foreignOf(where)) ?? 0
    ),
    findFirst: jest.fn(async ({ where }: any) =>
      where.AND ? opts.foreignProbe ?? null : opts.probe ?? null
    ),
  };
  const check = new YsocialTokenKeyCheck({ model: { integration } } as any);
  return { check, integration };
};

describe('YsocialTokenKeyCheck.check', () => {
  it('is off without key and without ciphertext', async () => {
    const { check, integration } = build({ orCount: 0 });
    expect(await check.check({})).toEqual({ encryption: 'off' });
    const where = integration.count.mock.calls[0][0].where;
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
    const filters = integration.count.mock.calls.map(([arg]: any) =>
      foreignOf(arg.where)
    );
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
    expect(integration.findFirst).toHaveBeenCalledTimes(1);
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
    const args = integration.findFirst.mock.calls[0] as any;
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
