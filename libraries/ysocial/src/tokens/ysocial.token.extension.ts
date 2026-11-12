import type { PrismaClient } from '@prisma/client';
import {
  decryptYsocialToken,
  encryptYsocialToken,
  readYsocialTokenKey,
  YSOCIAL_TOKEN_FIELDS,
  YsocialTokenKey,
} from './token.crypto';

/**
 * Prisma extension for the channel tokens (PLAN E24, PR 25). Postiz's
 * PrismaService returns the extended client from its constructor (patch 3,
 * YSOCIAL-PATCHES.md), so every Postiz and ysocial repository uses it.
 *
 * - Read: a result extension decrypts Integration.token and refreshToken, also
 *   in include and select of other models. Prisma computes the value on first
 *   access, a wrong key throws there.
 * - Write: one query hook for all models encrypts both fields in the data of
 *   create, createMany, update, updateMany and upsert, also in nested writes
 *   from other models. It never touches where, so a filter compares the raw
 *   value (the migration relies on that).
 * - Without YSOCIAL_TOKEN_KEY values are written as plaintext. That is the
 *   state before the key exists (B28). YsocialTokenKeyCheck stops the start
 *   once encrypted values exist.
 *
 * Every string is encrypted, also an empty one and one that already starts
 * with ys1:. A value that a user typed in can never be stored unencrypted.
 *
 * Gaps (spike PR 25): Prisma's fluent API (post.findUnique().integration())
 * returns the ciphertext, raw queries bypass the extension. Postiz uses
 * neither, ysocial.token.bypass.spec.ts checks the Postiz sources.
 */

const INTEGRATION = 'Integration';

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);

type Data = Record<string, unknown>;

interface RuntimeField {
  name: string;
  kind: string;
  type: string;
}

// Fields per model: model -> field -> target model of a relation, null for a
// scalar field.
export type YsocialDataModel = Record<string, Record<string, string | null>>;

const isObject = (value: unknown): value is Data =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const eachOrOne = (value: unknown, map: (item: unknown) => unknown) =>
  Array.isArray(value) ? value.map(map) : map(value);

// Prisma keeps its data model on the client (internal, no public API in
// 6.5). Without it nested writes would stay plaintext, so the client must not
// start.
export const readYsocialDataModel = (client: object): YsocialDataModel => {
  const models = (
    client as {
      _runtimeDataModel?: {
        models?: Record<string, { fields?: RuntimeField[] }>;
      };
    }
  )._runtimeDataModel?.models;
  const integrationFields = models?.[INTEGRATION]?.fields?.map((f) => f.name);
  if (
    !models ||
    !YSOCIAL_TOKEN_FIELDS.every((field) => integrationFields?.includes(field))
  ) {
    throw new Error(
      'ysocial: Datenmodell von Prisma nicht lesbar, die Token-Verschlüsselung kann nicht starten'
    );
  }

  return Object.fromEntries(
    Object.entries(models).map(([model, { fields = [] }]) => [
      model,
      Object.fromEntries(
        fields.map((field) => [
          field.name,
          field.kind === 'object' ? field.type : null,
        ])
      ),
    ])
  );
};

export const createYsocialTokenWriter = (
  dataModel: YsocialDataModel,
  key: YsocialTokenKey | undefined
) => {
  const relationsByModel = Object.fromEntries(
    Object.entries(dataModel).map(([model, fields]) => [
      model,
      Object.entries(fields).filter(
        (entry): entry is [string, string] => entry[1] !== null
      ),
    ])
  );

  const encryptFields = (data: Data) => {
    if (!key) {
      return;
    }
    for (const field of YSOCIAL_TOKEN_FIELDS) {
      const value = data[field];
      if (typeof value === 'string') {
        data[field] = encryptYsocialToken(value, field, key);
      } else if (isObject(value) && typeof value.set === 'string') {
        data[field] = {
          ...value,
          set: encryptYsocialToken(value.set, field, key),
        };
      }
    }
  };

  // Data of one row of model. Returns a copy, the caller's object stays as it
  // was.
  const writeData = (model: string, data: unknown): unknown => {
    if (!isObject(data)) {
      return data;
    }
    const copy: Data = { ...data };
    if (model === INTEGRATION) {
      encryptFields(copy);
    }
    for (const [name, target] of relationsByModel[model] || []) {
      if (isObject(copy[name])) {
        copy[name] = nestedWrite(target, copy[name] as Data);
      }
    }
    return copy;
  };

  // A nested update is { where, data }, a to-one update may also be the data
  // itself. Only a model with its own field "data" makes that ambiguous.
  const wrappedData = (target: string, value: unknown) =>
    isObject(value) &&
    'data' in value &&
    ('where' in value || !('data' in (dataModel[target] || {})))
      ? { ...value, data: writeData(target, value.data) }
      : writeData(target, value);

  // Nested write on a relation field: create, createMany, connectOrCreate,
  // update, updateMany, upsert. connect, set, disconnect and delete carry no
  // data.
  const nestedWrite = (target: string, ops: Data): Data => {
    const copy: Data = { ...ops };
    if ('create' in copy) {
      copy.create = eachOrOne(copy.create, (item) => writeData(target, item));
    }
    if (isObject(copy.createMany)) {
      copy.createMany = {
        ...copy.createMany,
        data: eachOrOne(copy.createMany.data, (item) =>
          writeData(target, item)
        ),
      };
    }
    if ('connectOrCreate' in copy) {
      copy.connectOrCreate = eachOrOne(copy.connectOrCreate, (item) =>
        isObject(item)
          ? { ...item, create: writeData(target, item.create) }
          : item
      );
    }
    if ('update' in copy) {
      copy.update = eachOrOne(copy.update, (item) => wrappedData(target, item));
    }
    if ('updateMany' in copy) {
      copy.updateMany = eachOrOne(copy.updateMany, (item) =>
        isObject(item) ? { ...item, data: writeData(target, item.data) } : item
      );
    }
    if ('upsert' in copy) {
      copy.upsert = eachOrOne(copy.upsert, (item) =>
        isObject(item)
          ? {
              ...item,
              create: writeData(target, item.create),
              update: writeData(target, item.update),
            }
          : item
      );
    }
    return copy;
  };

  // Arguments of a top-level operation. where, select and the rest stay as
  // they are.
  return (model: string, operation: string, args: unknown): unknown => {
    if (!WRITE_OPERATIONS.has(operation) || !isObject(args)) {
      return args;
    }
    const copy: Data = { ...args };
    for (const name of operation === 'upsert'
      ? ['create', 'update']
      : ['data']) {
      if (name in copy) {
        copy[name] = eachOrOne(copy[name], (item) => writeData(model, item));
      }
    }
    return copy;
  };
};

export const withYsocialTokenEncryption = <T extends PrismaClient>(
  client: T,
  env: Record<string, string | undefined> = process.env
): T => {
  const key = readYsocialTokenKey(env);
  const writeArgs = createYsocialTokenWriter(readYsocialDataModel(client), key);

  return client.$extends({
    name: 'ysocial-token-encryption',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(writeArgs(model, operation, args) as typeof args);
        },
      },
    },
    result: {
      integration: {
        token: {
          needs: { token: true },
          compute: (integration) =>
            decryptYsocialToken(integration.token, 'token', key),
        },
        refreshToken: {
          needs: { refreshToken: true },
          compute: (integration) =>
            integration.refreshToken === null
              ? null
              : decryptYsocialToken(
                  integration.refreshToken,
                  'refreshToken',
                  key
                ),
        },
      },
    },
  }) as unknown as T;
};
