// The real PostsService pulls in half of Postiz, some of it ESM-only.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

import { randomBytes } from 'crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialModule } from './ysocial.module';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialTestSwitchService } from '../../../../libraries/ysocial/src/health/ysocial.test.switch.service';

const TOKEN_ENV = 'YSOCIAL_SERVICE_TOKEN';
const ROUTES_ENV = 'YSOCIAL_TEST_ROUTES';
const LIST_ENV = 'YSOCIAL_TEST_INTEGRATIONS';
const ENVS = [TOKEN_ENV, ROUTES_ENV, LIST_ENV];
const token = randomBytes(32).toString('hex');

@Global()
@Module({
  providers: [
    { provide: PostsService, useValue: {} },
    { provide: TemporalService, useValue: {} },
  ],
  exports: [PostsService, TemporalService],
})
class PostsServiceTestModule {}

describe('/ysocial/test/integrations/:id/invalid-token', () => {
  const saved = ENVS.map((name) => process.env[name]);
  const store = { set: jest.fn(), del: jest.fn() };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PostsServiceTestModule, YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue({})
      .overrideProvider(YsocialRetryRepository)
      .useValue({})
      .overrideProvider(YsocialTokenKeyCheck)
      .useValue({})
      .overrideProvider(YsocialInboxRepository)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // The store is Redis in production, here a recorder (the in-memory mock
    // of Postiz ignores EX).
    (app.get(YsocialTestSwitchService) as any).store = store;
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.set.mockResolvedValue('OK');
    store.del.mockResolvedValue(1);
    process.env[TOKEN_ENV] = token;
    delete process.env[ROUTES_ENV];
    delete process.env[LIST_ENV];
  });

  afterEach(() => {
    ENVS.forEach((name, i) =>
      saved[i] === undefined
        ? delete process.env[name]
        : (process.env[name] = saved[i])
    );
  });

  const call = (method: 'POST' | 'DELETE', id = 'int-1', auth?: string) =>
    fetch(`${baseUrl}/ysocial/test/integrations/${id}/invalid-token`, {
      method,
      headers: auth ? { authorization: auth } : {},
    });

  describe.each(['POST', 'DELETE'] as const)('%s', (method) => {
    it.each([
      ['unset', undefined],
      ['false', 'false'],
      ['TRUE', 'TRUE'],
      ['1', '1'],
    ])(
      'answers 404 when YSOCIAL_TEST_ROUTES is %s, with and without token',
      async (_n, value) => {
        if (value !== undefined) {
          process.env[ROUTES_ENV] = value;
        }
        process.env[LIST_ENV] = 'int-1';
        expect((await call(method)).status).toBe(404);
        expect((await call(method, 'int-1', `Bearer ${token}`)).status).toBe(
          404
        );
        expect(store.set).not.toHaveBeenCalled();
        expect(store.del).not.toHaveBeenCalled();
      }
    );

    it('answers 401 without token and with a wrong token when routes are on', async () => {
      process.env[ROUTES_ENV] = 'true';
      process.env[LIST_ENV] = 'int-1';
      expect((await call(method)).status).toBe(401);
      expect(
        (
          await call(
            method,
            'int-1',
            `Bearer ${randomBytes(32).toString('hex')}`
          )
        ).status
      ).toBe(401);
      expect(store.set).not.toHaveBeenCalled();
      expect(store.del).not.toHaveBeenCalled();
    });

    it('answers 403 not_test_integration for a channel that is not listed', async () => {
      process.env[ROUTES_ENV] = 'true';
      process.env[LIST_ENV] = 'int-1, int-2';
      const res = await call(method, 'int-9', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'not_test_integration' });
      expect(store.set).not.toHaveBeenCalled();
      expect(store.del).not.toHaveBeenCalled();
    });

    it('answers 403 when the list is empty', async () => {
      process.env[ROUTES_ENV] = 'true';
      const res = await call(method, 'int-1', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });

  it('POST sets the switch for 30 minutes (id from a list with spaces)', async () => {
    process.env[ROUTES_ENV] = 'true';
    process.env[LIST_ENV] = 'int-1 , int-2,,';
    const before = Date.now();
    const res = await call('POST', 'int-2', `Bearer ${token}`);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ integrationId: 'int-2', invalidToken: true });
    const until = Date.parse(body.until);
    expect(until).toBeGreaterThanOrEqual(before + 1800_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 1800_000);
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(
      'ysocial:test:invalid-token:int-2',
      expect.any(String),
      'EX',
      1800
    );
    expect(store.del).not.toHaveBeenCalled();
  });

  it('DELETE clears the switch', async () => {
    process.env[ROUTES_ENV] = 'true';
    process.env[LIST_ENV] = 'int-1';
    const res = await call('DELETE', 'int-1', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      integrationId: 'int-1',
      invalidToken: false,
    });
    expect(store.del).toHaveBeenCalledWith('ysocial:test:invalid-token:int-1');
    expect(store.set).not.toHaveBeenCalled();
  });
});
