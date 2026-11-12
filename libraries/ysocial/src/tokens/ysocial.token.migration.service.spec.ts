import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { YSOCIAL_TOKEN_KEY_ENV, YsocialTokenKeyError } from './token.crypto';
import { YsocialTokenMigrationService } from './ysocial.token.migration.service';

type Row = { id: string; token: string; refreshToken: string | null };

// A mock of the integration delegate that serves the plaintext rows by
// id > lastId in batches, like the where of the service asks for.
const build = (
  rows: Row[],
  options: { updateCount?: (where: any) => number; remaining?: number } = {}
) => {
  const findMany = jest.fn(async ({ where, take }: any) => {
    const gt = JSON.stringify(where).match(/"id":\{"gt":"([^"]+)"\}/)?.[1];
    return rows.filter((row) => !gt || row.id > gt).slice(0, take);
  });
  const updateMany = jest.fn(async ({ where }: any) => ({
    count: options.updateCount ? options.updateCount(where) : 1,
  }));
  const count = jest.fn(async () => options.remaining ?? 0);
  const service = new YsocialTokenMigrationService({
    model: { integration: { findMany, updateMany, count } },
  } as any);
  return { service, findMany, updateMany, count };
};

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, '0')}`,
    token: `plain-token-${i}`,
    refreshToken: i % 2 ? `plain-refresh-${i}` : null,
  }));

describe('YsocialTokenMigrationService', () => {
  const saved = process.env[YSOCIAL_TOKEN_KEY_ENV];

  beforeEach(() => {
    process.env[YSOCIAL_TOKEN_KEY_ENV] = randomBytes(32).toString('base64');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) {
      delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    } else {
      process.env[YSOCIAL_TOKEN_KEY_ENV] = saved;
    }
  });

  it('refuses to run without a key', async () => {
    delete process.env[YSOCIAL_TOKEN_KEY_ENV];
    const { service, findMany, updateMany } = build(rows(2));
    await expect(service.migrate()).rejects.toBeInstanceOf(
      YsocialTokenKeyError
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses to run with an invalid key', async () => {
    process.env[YSOCIAL_TOKEN_KEY_ENV] = randomBytes(8).toString('base64');
    const { service } = build(rows(1));
    await expect(service.migrate()).rejects.toBeInstanceOf(
      YsocialTokenKeyError
    );
  });

  it('reads in batches with id > lastId until empty', async () => {
    const data = rows(5);
    const { service, findMany } = build(data);
    await service.migrate(2);
    const tokenCalls = findMany.mock.calls
      .map(([arg]: any) => arg)
      .filter(
        (arg: any) => !JSON.stringify(arg.where).includes('refreshToken')
      );
    // 5 rows with take 2: batches of 2, 2, 1 and then an empty read
    expect(tokenCalls).toHaveLength(4);
    expect(tokenCalls[0].where.AND).toHaveLength(1);
    expect(tokenCalls[1].where.AND[1]).toEqual({ id: { gt: 'id-001' } });
    expect(tokenCalls[2].where.AND[1]).toEqual({ id: { gt: 'id-003' } });
    expect(tokenCalls[3].where.AND[1]).toEqual({ id: { gt: 'id-004' } });
    for (const arg of tokenCalls) {
      expect(arg.take).toBe(2);
      expect(arg.orderBy).toEqual({ id: 'asc' });
    }
  });

  it('writes back the stored plaintext with id and value in where', async () => {
    const data = rows(3);
    const { service, updateMany } = build(data);
    await service.migrate();
    const tokenWrites = updateMany.mock.calls
      .map(([arg]: any) => arg)
      .filter((arg: any) => 'token' in arg.where);
    expect(tokenWrites).toEqual(
      data.map((row) => ({
        where: { id: row.id, token: row.token },
        data: { token: row.token },
      }))
    );
  });

  it('writes the refreshToken only for rows that have one', async () => {
    const data = rows(4);
    const { service, findMany, updateMany } = build(data);
    await service.migrate();
    const refreshFilter = findMany.mock.calls
      .map(([arg]: any) => arg)
      .find((arg: any) => JSON.stringify(arg.where).includes('refreshToken'));
    expect(refreshFilter.where.AND[0].AND[0]).toEqual({
      refreshToken: { not: null },
    });
    const tokenFilter = findMany.mock.calls[0][0] as any;
    expect(JSON.stringify(tokenFilter.where)).not.toContain('"not":null');
    // the filter excludes already encrypted values
    expect(JSON.stringify(tokenFilter.where)).toContain('ys1:');
    const refreshWrites = updateMany.mock.calls
      .map(([arg]: any) => arg)
      .filter((arg: any) => 'refreshToken' in arg.where);
    expect(refreshWrites.length).toBeGreaterThan(0);
    for (const write of refreshWrites) {
      expect(write.data).toEqual({ refreshToken: write.where.refreshToken });
    }
  });

  it('counts count 0 as changedMeanwhile', async () => {
    const data = rows(3);
    const { service } = build(data, {
      updateCount: (where) =>
        where.id === 'id-001' && 'token' in where ? 0 : 1,
    });
    const result = await service.migrate();
    expect(result.token).toEqual({
      encrypted: 2,
      changedMeanwhile: 1,
      remaining: 0,
    });
  });

  it('reports the remaining plaintext rows', async () => {
    const { service, count } = build(rows(1), { remaining: 7 });
    const result = await service.migrate();
    expect(result.token.remaining).toBe(7);
    expect(result.refreshToken.remaining).toBe(7);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, 1],
    [-5, 1],
    [NaN, 1],
    [2.9, 2],
    [100, 100],
    [500, 500],
    [501, 500],
    [100000, 500],
  ])('limits batchSize %p to %p', async (input, expected) => {
    const { service, findMany } = build(rows(1));
    await service.migrate(input);
    expect((findMany.mock.calls[0][0] as any).take).toBe(expected);
  });

  it('uses 100 by default', async () => {
    const { service, findMany } = build(rows(1));
    await service.migrate();
    expect((findMany.mock.calls[0][0] as any).take).toBe(100);
  });

  it('returns numbers only, no token value', async () => {
    const data = rows(4);
    const { service } = build(data);
    const result = await service.migrate();
    for (const field of ['token', 'refreshToken'] as const) {
      expect(Object.keys(result[field]).sort()).toEqual([
        'changedMeanwhile',
        'encrypted',
        'remaining',
      ]);
      for (const value of Object.values(result[field])) {
        expect(typeof value).toBe('number');
      }
    }
    const text = JSON.stringify(result);
    for (const row of data) {
      expect(text).not.toContain(row.token);
    }
  });

  it('logs counts only', async () => {
    const lines: string[] = [];
    (Logger.prototype.log as jest.Mock).mockImplementation((m: unknown) =>
      lines.push(String(m))
    );
    const data = rows(3);
    const { service } = build(data);
    await service.migrate();
    expect(lines.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(lines.join('\n')).not.toContain(row.token);
    }
  });
});
