import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createYsocialTokenWriter,
  readYsocialDataModel,
  withYsocialTokenEncryption,
  YsocialDataModel,
} from './ysocial.token.extension';
import {
  decryptYsocialToken,
  readYsocialTokenKey,
  YSOCIAL_TOKEN_KEY_ENV,
  YsocialTokenKey,
} from './token.crypto';

// The data model comes from the real schema, the way _runtimeDataModel
// delivers it: field -> target model for a relation, null for a scalar.
const parseSchema = (): YsocialDataModel => {
  const source = readFileSync(
    join(
      __dirname,
      '../../../nestjs-libraries/src/database/prisma/schema.prisma'
    ),
    'utf8'
  );
  const blocks = [...source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((block) => block[1]));
  return Object.fromEntries(
    blocks.map(([, name, body]) => [
      name,
      Object.fromEntries(
        body
          .split('\n')
          .map((line) => line.trim().match(/^(\w+)\s+(\w+)(\[\])?(\?)?/))
          .filter((m): m is RegExpMatchArray => !!m && !m[1].startsWith('@'))
          .map((m) => [m[1], names.has(m[2]) ? m[2] : null])
      ),
    ])
  );
};

const dataModel = parseSchema();
const key = readYsocialTokenKey({
  [YSOCIAL_TOKEN_KEY_ENV]: randomBytes(32).toString('base64'),
}) as YsocialTokenKey;
const write = createYsocialTokenWriter(dataModel, key);
const writePlain = createYsocialTokenWriter(dataModel, undefined);

const PLAIN = 'plain-token-value';
const REFRESH = 'plain-refresh-value';

const isEnc = (value: unknown) =>
  typeof value === 'string' && value.startsWith(`ys1:${key.kid}:`);
const dec = (value: unknown, field: 'token' | 'refreshToken' = 'token') =>
  decryptYsocialToken(value as string, field, key);

// Asserts that value is ciphertext of the field and returns the plaintext.
const expectEncrypted = (
  value: unknown,
  plain: string,
  field: 'token' | 'refreshToken' = 'token'
) => {
  expect(isEnc(value)).toBe(true);
  expect(dec(value, field)).toBe(plain);
};

const integrationData = (extra: object = {}) => ({
  name: 'x',
  token: PLAIN,
  refreshToken: REFRESH,
  ...extra,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('schema parser (test helper)', () => {
  it('finds the Integration relations of the schema', () => {
    const toIntegration = Object.entries(dataModel).flatMap(([model, fields]) =>
      Object.entries(fields)
        .filter(([, target]) => target === 'Integration')
        .map(([name]) => `${model}.${name}`)
    );
    expect(toIntegration.sort()).toEqual(
      expect.arrayContaining([
        'Organization.Integration',
        'Customer.integrations',
        'Post.integration',
      ])
    );
    expect(dataModel.Integration.token).toBeNull();
    expect(dataModel.GitHub.token).toBeNull();
  });
});

describe('top-level writes', () => {
  it('encrypts create', () => {
    const args = write('Integration', 'create', {
      data: integrationData(),
    }) as any;
    expectEncrypted(args.data.token, PLAIN);
    expectEncrypted(args.data.refreshToken, REFRESH, 'refreshToken');
    expect(args.data.name).toBe('x');
  });

  it('encrypts createMany with an array and a single object', () => {
    const many = write('Integration', 'createMany', {
      data: [integrationData(), integrationData({ token: 'second' })],
    }) as any;
    expectEncrypted(many.data[0].token, PLAIN);
    expectEncrypted(many.data[1].token, 'second');
    const single = write('Integration', 'createMany', {
      data: integrationData(),
    }) as any;
    expectEncrypted(single.data.token, PLAIN);
  });

  it('encrypts createManyAndReturn and updateManyAndReturn', () => {
    const created = write('Integration', 'createManyAndReturn', {
      data: [integrationData()],
    }) as any;
    expectEncrypted(created.data[0].token, PLAIN);
    const updated = write('Integration', 'updateManyAndReturn', {
      where: { id: '1' },
      data: { token: PLAIN },
    }) as any;
    expectEncrypted(updated.data.token, PLAIN);
  });

  it('encrypts update with a string and with { set }', () => {
    const plain = write('Integration', 'update', {
      where: { id: '1' },
      data: { token: PLAIN, refreshToken: REFRESH },
    }) as any;
    expectEncrypted(plain.data.token, PLAIN);
    expectEncrypted(plain.data.refreshToken, REFRESH, 'refreshToken');

    const set = write('Integration', 'update', {
      where: { id: '1' },
      data: { token: { set: PLAIN }, refreshToken: { set: REFRESH } },
    }) as any;
    expectEncrypted(set.data.token.set, PLAIN);
    expectEncrypted(set.data.refreshToken.set, REFRESH, 'refreshToken');
  });

  it('encrypts updateMany', () => {
    const args = write('Integration', 'updateMany', {
      where: { organizationId: 'o' },
      data: { token: PLAIN },
    }) as any;
    expectEncrypted(args.data.token, PLAIN);
  });

  it('encrypts both branches of upsert', () => {
    const args = write('Integration', 'upsert', {
      where: { id: '1' },
      create: integrationData(),
      update: { token: 'upd', refreshToken: { set: 'upd-r' } },
    }) as any;
    expectEncrypted(args.create.token, PLAIN);
    expectEncrypted(args.create.refreshToken, REFRESH, 'refreshToken');
    expectEncrypted(args.update.token, 'upd');
    expectEncrypted(args.update.refreshToken.set, 'upd-r', 'refreshToken');
  });

  it('keeps null as null and encrypts the empty string', () => {
    const args = write('Integration', 'create', {
      data: { token: '', refreshToken: null },
    }) as any;
    expectEncrypted(args.data.token, '');
    expect(args.data.refreshToken).toBeNull();
    const set = write('Integration', 'update', {
      where: { id: '1' },
      data: { refreshToken: { set: null } },
    }) as any;
    expect(set.data.refreshToken).toEqual({ set: null });
  });

  it('encrypts a value that already starts with ys1:', () => {
    const args = write('Integration', 'create', {
      data: { token: 'ys1:abcdef01:a:b:c' },
    }) as any;
    expectEncrypted(args.data.token, 'ys1:abcdef01:a:b:c');
  });

  it('leaves fields it does not know and undefined alone', () => {
    const args = write('Integration', 'update', {
      where: { id: '1' },
      data: { name: 'n', picture: undefined },
    }) as any;
    expect(args.data).toEqual({ name: 'n', picture: undefined });
  });
});

describe('nested writes', () => {
  const orgData = (integrations: object) => ({
    name: 'org',
    Integration: integrations,
  });

  it('encrypts Organization.Integration.create (single and array)', () => {
    const single = write('Organization', 'create', {
      data: orgData({ create: integrationData() }),
    }) as any;
    expectEncrypted(single.data.Integration.create.token, PLAIN);

    const many = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        create: [integrationData(), integrationData({ token: 'b' })],
      }),
    }) as any;
    expectEncrypted(many.data.Integration.create[0].token, PLAIN);
    expectEncrypted(many.data.Integration.create[1].token, 'b');
  });

  it('encrypts createMany.data', () => {
    const args = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        createMany: { data: [integrationData()], skipDuplicates: true },
      }),
    }) as any;
    expectEncrypted(args.data.Integration.createMany.data[0].token, PLAIN);
    expect(args.data.Integration.createMany.skipDuplicates).toBe(true);
  });

  it('encrypts connectOrCreate.create and leaves its where', () => {
    const args = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        connectOrCreate: {
          where: { id: 'i', token: PLAIN },
          create: integrationData(),
        },
      }),
    }) as any;
    const coc = args.data.Integration.connectOrCreate;
    expectEncrypted(coc.create.token, PLAIN);
    expect(coc.where).toEqual({ id: 'i', token: PLAIN });
  });

  it('encrypts nested update as { where, data } and as an array', () => {
    const one = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({ update: { where: { id: 'i' }, data: { token: PLAIN } } }),
    }) as any;
    expectEncrypted(one.data.Integration.update.data.token, PLAIN);
    expect(one.data.Integration.update.where).toEqual({ id: 'i' });

    const list = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        update: [
          { where: { id: 'i' }, data: { token: PLAIN } },
          { where: { id: 'j' }, data: { refreshToken: { set: REFRESH } } },
        ],
      }),
    }) as any;
    expectEncrypted(list.data.Integration.update[0].data.token, PLAIN);
    expectEncrypted(
      list.data.Integration.update[1].data.refreshToken.set,
      REFRESH,
      'refreshToken'
    );
  });

  it('encrypts nested updateMany, leaving its where', () => {
    const args = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        updateMany: { where: { token: PLAIN }, data: { token: 'new' } },
      }),
    }) as any;
    expectEncrypted(args.data.Integration.updateMany.data.token, 'new');
    expect(args.data.Integration.updateMany.where).toEqual({ token: PLAIN });
  });

  it('encrypts nested upsert', () => {
    const args = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        upsert: {
          where: { id: 'i' },
          create: integrationData(),
          update: { token: 'u' },
        },
      }),
    }) as any;
    expectEncrypted(args.data.Integration.upsert.create.token, PLAIN);
    expectEncrypted(args.data.Integration.upsert.update.token, 'u');
  });

  it('encrypts Customer.integrations', () => {
    const args = write('Customer', 'create', {
      data: { name: 'c', integrations: { create: integrationData() } },
    }) as any;
    expectEncrypted(args.data.integrations.create.token, PLAIN);
  });

  it('encrypts Post.integration create and update', () => {
    const created = write('Post', 'create', {
      data: { content: 'c', integration: { create: integrationData() } },
    }) as any;
    expectEncrypted(created.data.integration.create.token, PLAIN);

    // A to-one update may be the plain data (no { where, data }).
    const direct = write('Post', 'update', {
      where: { id: 'p' },
      data: { integration: { update: { token: PLAIN } } },
    }) as any;
    expectEncrypted(direct.data.integration.update.token, PLAIN);

    const wrapped = write('Post', 'update', {
      where: { id: 'p' },
      data: { integration: { update: { where: {}, data: { token: PLAIN } } } },
    }) as any;
    expectEncrypted(wrapped.data.integration.update.data.token, PLAIN);
  });

  it('encrypts deep nesting organization -> customers -> integrations', () => {
    const args = write('Organization', 'create', {
      data: {
        name: 'org',
        customers: {
          create: [
            {
              name: 'c',
              integrations: {
                create: [integrationData(), integrationData({ token: 'z' })],
              },
            },
          ],
        },
      },
    }) as any;
    const ints = args.data.customers.create[0].integrations.create;
    expectEncrypted(ints[0].token, PLAIN);
    expectEncrypted(ints[1].token, 'z');
  });

  it('encrypts deep nesting through posts down to the integration', () => {
    const args = write('Organization', 'create', {
      data: {
        name: 'org',
        post: {
          create: { content: 'c', integration: { create: integrationData() } },
        },
      },
    }) as any;
    expectEncrypted(args.data.post.create.integration.create.token, PLAIN);
  });

  it('does not encrypt connect, set, disconnect or delete', () => {
    const args = write('Organization', 'update', {
      where: { id: 'o' },
      data: orgData({
        connect: { id: 'i' },
        disconnect: { id: 'j' },
        delete: { id: 'k' },
      }),
    }) as any;
    expect(args.data.Integration).toEqual({
      connect: { id: 'i' },
      disconnect: { id: 'j' },
      delete: { id: 'k' },
    });
  });
});

describe('what stays untouched', () => {
  it('never changes where, also with token inside', () => {
    const where = {
      id: 'i',
      token: PLAIN,
      refreshToken: { not: null as string | null },
      AND: [{ token: { startsWith: 'ys1:' } }],
      integration: { token: PLAIN },
    };
    for (const operation of ['update', 'updateMany', 'upsert', 'delete']) {
      const args = write('Integration', operation, {
        where: clone(where),
        data: { token: PLAIN },
        create: { token: PLAIN },
        update: { token: PLAIN },
      }) as any;
      expect(args.where).toEqual(where);
    }
    // top-level updateMany as the migration does it
    const migration = write('Integration', 'updateMany', {
      where: { id: 'i', token: PLAIN },
      data: { token: PLAIN },
    }) as any;
    expect(migration.where).toEqual({ id: 'i', token: PLAIN });
    expectEncrypted(migration.data.token, PLAIN);
  });

  it('leaves where of a nested write on a relation alone', () => {
    const args = write('Post', 'findMany', {
      where: { integration: { token: PLAIN } },
    }) as any;
    expect(args).toEqual({ where: { integration: { token: PLAIN } } });
  });

  it('leaves reads alone', () => {
    for (const operation of [
      'findMany',
      'findFirst',
      'findUnique',
      'findFirstOrThrow',
      'findUniqueOrThrow',
      'count',
      'aggregate',
      'groupBy',
      'delete',
      'deleteMany',
    ]) {
      const args = {
        where: { token: PLAIN },
        data: { token: PLAIN },
        select: { token: true },
      };
      expect(write('Integration', operation, clone(args))).toEqual(args);
    }
  });

  it('does not change the object of the caller', () => {
    const args = {
      where: { id: 'o' },
      data: {
        name: 'org',
        Integration: {
          create: [integrationData()],
          update: { where: { id: 'i' }, data: { token: PLAIN } },
        },
      },
    };
    const before = clone(args);
    const result = write('Organization', 'update', args);
    expect(args).toEqual(before);
    expect(result).not.toBe(args);

    const direct = { data: integrationData() };
    const directBefore = clone(direct);
    write('Integration', 'create', direct);
    expect(direct).toEqual(directBefore);
  });

  it('does not encrypt GitHub.token or other models with a token field', () => {
    const args = write('GitHub', 'create', {
      data: { token: PLAIN, organizationId: 'o' },
    }) as any;
    expect(args.data.token).toBe(PLAIN);
    const upd = write('GitHub', 'update', {
      where: { id: '1' },
      data: { token: { set: PLAIN } },
    }) as any;
    expect(upd.data.token).toEqual({ set: PLAIN });
  });

  it('returns non-object args as they are', () => {
    expect(write('Integration', 'create', undefined)).toBeUndefined();
    expect(write('Integration', 'findMany', undefined)).toBeUndefined();
  });

  it('writes plaintext without a key', () => {
    const args = writePlain('Organization', 'create', {
      data: {
        name: 'org',
        Integration: { create: integrationData() },
      },
    }) as any;
    expect(args.data.Integration.create.token).toBe(PLAIN);
    expect(args.data.Integration.create.refreshToken).toBe(REFRESH);
    const set = writePlain('Integration', 'update', {
      where: { id: '1' },
      data: { token: { set: PLAIN } },
    }) as any;
    expect(set.data.token).toEqual({ set: PLAIN });
  });
});

describe('readYsocialDataModel', () => {
  const runtime = (models: object) => ({ _runtimeDataModel: { models } });
  const integration = {
    fields: [
      { name: 'token', kind: 'scalar', type: 'String' },
      { name: 'refreshToken', kind: 'scalar', type: 'String' },
      { name: 'customer', kind: 'object', type: 'Customer' },
    ],
  };

  it('maps relations to the target model and scalars to null', () => {
    expect(readYsocialDataModel(runtime({ Integration: integration }))).toEqual(
      {
        Integration: { token: null, refreshToken: null, customer: 'Customer' },
      }
    );
  });

  it.each([
    ['no _runtimeDataModel', {}],
    ['no models', { _runtimeDataModel: {} }],
    ['no Integration model', runtime({ Other: integration })],
    [
      'no refreshToken field',
      runtime({
        Integration: {
          fields: [{ name: 'token', kind: 'scalar', type: 'String' }],
        },
      }),
    ],
    ['no fields', runtime({ Integration: {} })],
  ])('throws for %s', (_name, client) => {
    expect(() => readYsocialDataModel(client)).toThrow(/nicht lesbar/);
  });
});

describe('withYsocialTokenEncryption', () => {
  const keyBase64 = randomBytes(32).toString('base64');
  const env = { [YSOCIAL_TOKEN_KEY_ENV]: keyBase64 };
  const fieldsOf = (name: string) =>
    Object.keys(dataModel[name]).map((field) => ({
      name: field,
      kind: dataModel[name][field] ? 'object' : 'scalar',
      type: dataModel[name][field] || 'String',
    }));

  const fakeClient = () => {
    const captured: { definition?: any } = {};
    const client: any = {
      _runtimeDataModel: {
        models: Object.fromEntries(
          Object.keys(dataModel).map((name) => [
            name,
            { fields: fieldsOf(name) },
          ])
        ),
      },
      $extends: jest.fn((definition: unknown) => {
        captured.definition = definition;
        return { extended: true };
      }),
    };
    return { client, captured };
  };

  it('returns the extended client', () => {
    const { client } = fakeClient();
    expect(withYsocialTokenEncryption(client, env)).toEqual({ extended: true });
    expect(client.$extends).toHaveBeenCalledTimes(1);
  });

  it('decrypts token and refreshToken in the result extension', () => {
    const { client, captured } = fakeClient();
    withYsocialTokenEncryption(client, env);
    const k = readYsocialTokenKey(env) as YsocialTokenKey;
    const { token, refreshToken } = captured.definition.result.integration;

    expect(token.needs).toEqual({ token: true });
    expect(refreshToken.needs).toEqual({ refreshToken: true });

    const write2 = createYsocialTokenWriter(dataModel, k);
    const stored = write2('Integration', 'create', {
      data: { token: PLAIN, refreshToken: REFRESH },
    }) as any;
    expect(token.compute({ token: stored.data.token })).toBe(PLAIN);
    expect(
      refreshToken.compute({ refreshToken: stored.data.refreshToken })
    ).toBe(REFRESH);
    // plaintext from before the migration passes through
    expect(token.compute({ token: 'old-plain' })).toBe('old-plain');
    expect(refreshToken.compute({ refreshToken: null })).toBeNull();
  });

  it('passes the encrypted args to query in $allOperations', async () => {
    const { client, captured } = fakeClient();
    withYsocialTokenEncryption(client, env);
    const query = jest.fn(async (args: unknown) => args);
    const result: any =
      await captured.definition.query.$allModels.$allOperations({
        model: 'Integration',
        operation: 'create',
        args: { data: { token: PLAIN } },
        query,
      });
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.data.token).toMatch(/^ys1:[0-9a-f]{8}:/);
    expect(result.data.token).not.toContain(PLAIN);

    const read: any = await captured.definition.query.$allModels.$allOperations(
      {
        model: 'Integration',
        operation: 'findMany',
        args: { where: { token: PLAIN } },
        query,
      }
    );
    expect(read).toEqual({ where: { token: PLAIN } });
  });

  it('writes plaintext through the hook without a key', async () => {
    const { client, captured } = fakeClient();
    withYsocialTokenEncryption(client, {});
    const query = jest.fn(async (args: unknown) => args);
    const result: any =
      await captured.definition.query.$allModels.$allOperations({
        model: 'Integration',
        operation: 'create',
        args: { data: { token: PLAIN } },
        query,
      });
    expect(result.data.token).toBe(PLAIN);
  });

  it('throws at the call for an invalid key', () => {
    const { client } = fakeClient();
    expect(() =>
      withYsocialTokenEncryption(client, {
        [YSOCIAL_TOKEN_KEY_ENV]: randomBytes(16).toString('base64'),
      })
    ).toThrow(/ungültig/);
    expect(client.$extends).not.toHaveBeenCalled();
  });

  it('throws at the call when the data model is unreadable', () => {
    expect(() =>
      withYsocialTokenEncryption({ $extends: jest.fn() } as any, env)
    ).toThrow(/nicht lesbar/);
  });
});
