// The real PostsService pulls in half of Postiz, some of it ESM-only.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { randomBytes } from 'crypto';
import {
  Global,
  INestApplication,
  Logger,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialModule } from './ysocial.module';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';

const TOKEN_ENV = 'YSOCIAL_SERVICE_TOKEN';
const LIST_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
const serviceToken = randomBytes(32).toString('hex');
const pageToken = randomBytes(24).toString('hex');
const userToken = randomBytes(24).toString('hex');

// Invented data only.
const CHANNEL = 'int-demo-1';
const OTHER_CHANNEL = 'int-other-1';
const IG = '17840000000000001';
const MEDIA = '17900000000000001';
const FOREIGN_MEDIA = '17900000000000009';
const COMMENT = '17950000000000001';
const FOREIGN_COMMENT = '17950000000000009';
const REPLY_ID = '17950000000000003';
const ACTOR = 'anna@example.com';
const COMMENT_TEXT = 'Erfundener Kommentar';
const COMMENTER = 'erfundene_person';
const REPLY_TEXT = 'Erfundene Antwort des Kontos';
const META_MESSAGE = 'Erfundene Meldung von Meta, nie im Log';

const row = (patch: Record<string, unknown> = {}): any => ({
  id: CHANNEL,
  providerIdentifier: 'instagram',
  internalId: IG,
  token: `${pageToken}___${userToken}`,
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  deletedAt: null,
  ...patch,
});

const repository = { getChannelForInbox: jest.fn() };
const postsService = {};
const integrationManager = {};
const temporalService = {};

// Stand-ins for what the Global DatabaseModule of Postiz provides.
@Global()
@Module({
  providers: [
    { provide: PostsService, useValue: postsService },
    { provide: IntegrationManager, useValue: integrationManager },
    { provide: TemporalService, useValue: temporalService },
  ],
  exports: [PostsService, IntegrationManager, TemporalService],
})
class InboxTestModule {}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type GraphCall = { method: string; url: URL; body: URLSearchParams | null };
const graphCalls: GraphCall[] = [];
let graphHandler: (call: GraphCall) => Response | Promise<Response>;

// The platform: a comment on an own post, one on a foreign post.
const defaultGraph = ({ method, url }: GraphCall): Response => {
  const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
  if (method === 'GET' && path === `/${IG}/media`) {
    return json({
      data: [
        {
          id: MEDIA,
          permalink: 'https://www.instagram.com/p/ERFUNDEN/',
          timestamp: '2026-11-01T10:00:00+0000',
          media_type: 'IMAGE',
          comments_count: 2,
        },
        { id: FOREIGN_MEDIA, comments_count: 0 },
      ],
    });
  }
  if (method === 'GET' && path === `/${MEDIA}/comments`) {
    return json({
      data: [
        {
          id: COMMENT,
          text: COMMENT_TEXT,
          username: COMMENTER,
          timestamp: '2026-11-02T10:00:00+0000',
          like_count: 2,
          hidden: false,
          replies: {
            data: [
              {
                id: REPLY_ID,
                text: REPLY_TEXT,
                username: 'konto',
                timestamp: '2026-11-02T11:00:00+0000',
                like_count: 0,
                hidden: false,
              },
            ],
          },
        },
      ],
    });
  }
  if (method === 'GET' && path === `/${COMMENT}`) {
    return json({ id: COMMENT, media: { id: MEDIA } });
  }
  if (method === 'GET' && path === `/${FOREIGN_COMMENT}`) {
    return json({ id: FOREIGN_COMMENT, media: { id: FOREIGN_MEDIA } });
  }
  if (method === 'GET' && path === `/${MEDIA}`) {
    return json({ id: MEDIA, owner: { id: IG } });
  }
  if (method === 'GET' && path === `/${FOREIGN_MEDIA}`) {
    return json({ id: FOREIGN_MEDIA, owner: { id: '17840000000000999' } });
  }
  if (method === 'POST' && path === `/${COMMENT}/replies`) {
    return json({ id: REPLY_ID });
  }
  if (method === 'POST' && path === `/${COMMENT}`) {
    return json({ success: true });
  }
  if (method === 'DELETE' && path === `/${COMMENT}`) {
    return json({ success: true });
  }
  return json({ error: { message: 'unexpected call', code: 1 } }, 400);
};

describe('/ysocial/inbox', () => {
  const savedEnv = [TOKEN_ENV, LIST_ENV].map((name) => process.env[name]);
  const realFetch = global.fetch;
  let app: INestApplication;
  let baseUrl: string;
  let logs: jest.SpyInstance[];
  let logLines: string[];
  let responses: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [InboxTestModule, YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue({})
      .overrideProvider(YsocialRetryRepository)
      .useValue({})
      .overrideProvider(YsocialTokenKeyCheck)
      .useValue({})
      .overrideProvider(YsocialInboxRepository)
      .useValue(repository)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Same pipe as apps/backend/src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    global.fetch = realFetch;
    [TOKEN_ENV, LIST_ENV].forEach((name, i) => {
      if (savedEnv[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[i];
      }
    });
  });

  beforeEach(() => {
    process.env[TOKEN_ENV] = serviceToken;
    process.env[LIST_ENV] = CHANNEL;
    jest.clearAllMocks();
    graphCalls.length = 0;
    responses = [];
    graphHandler = defaultGraph;
    repository.getChannelForInbox.mockResolvedValue(row());

    // Only calls to the Graph API are caught, the test itself calls the
    // server with fetch.
    global.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (!url.startsWith('https://graph.facebook.com/')) {
        return realFetch(input, init);
      }
      const call: GraphCall = {
        method: init.method || 'GET',
        url: new URL(url),
        body: init.body ? new URLSearchParams(init.body) : null,
      };
      graphCalls.push(call);
      return graphHandler(call);
    }) as typeof fetch;

    logLines = [];
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        logLines.push(args.map(String).join(' '));
      })
    );
  });

  afterEach(() => {
    logs.forEach((spy) => spy.mockRestore());
    global.fetch = realFetch;

    // Privacy, in every case, errors included: no comment text, name, reply
    // text, token or message of the platform in a log line, no token in an
    // answer.
    const secrets = [
      COMMENT_TEXT,
      COMMENTER,
      REPLY_TEXT,
      META_MESSAGE,
      pageToken,
      userToken,
      serviceToken,
    ];
    const log = logLines.join('\n');
    for (const secret of secrets) {
      expect(log).not.toContain(secret);
    }
    for (const text of responses) {
      for (const secret of [pageToken, userToken, serviceToken]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  const request = async (
    method: string,
    path: string,
    {
      auth = `Bearer ${serviceToken}`,
      actor = ACTOR as string | null,
      body,
      raw,
    }: {
      auth?: string;
      actor?: string | null;
      body?: unknown;
      raw?: string;
    } = {}
  ) => {
    const hasBody = body !== undefined || raw !== undefined;
    const res = await fetch(`${baseUrl}/ysocial/inbox${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(actor ? { 'x-ysocial-actor': actor } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasBody ? raw ?? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    responses.push(text);
    return {
      status: res.status,
      text,
      json: () => (text ? JSON.parse(text) : undefined),
    };
  };

  const read = (id = CHANNEL, opts = {}) =>
    request('GET', `/integrations/${id}/comments`, opts);
  const reply = (
    id = CHANNEL,
    commentId = COMMENT,
    opts: Parameters<typeof request>[2] = { body: { message: REPLY_TEXT } }
  ) =>
    request('POST', `/integrations/${id}/comments/${commentId}/replies`, opts);
  const hide = (
    id = CHANNEL,
    commentId = COMMENT,
    opts: Parameters<typeof request>[2] = { body: { hide: true } }
  ) => request('POST', `/integrations/${id}/comments/${commentId}/hide`, opts);
  const remove = (
    id = CHANNEL,
    commentId = COMMENT,
    opts: Parameters<typeof request>[2] = { body: { confirmDelete: true } }
  ) => request('DELETE', `/integrations/${id}/comments/${commentId}`, opts);

  const writes = () => graphCalls.filter((call) => call.method !== 'GET');
  const nothingTouched = () => {
    expect(graphCalls).toEqual([]);
    expect(repository.getChannelForInbox).not.toHaveBeenCalled();
  };

  const bodies = {
    reply: { message: REPLY_TEXT },
    hide: { hide: true },
    remove: { confirmDelete: true },
  };
  // One call per route with the given headers, valid bodies.
  const allRoutes = (opts: { auth?: string } = {}) => [
    () => read(CHANNEL, opts),
    () => reply(CHANNEL, COMMENT, { ...opts, body: bodies.reply }),
    () => hide(CHANNEL, COMMENT, { ...opts, body: bodies.hide }),
    () => remove(CHANNEL, COMMENT, { ...opts, body: bodies.remove }),
  ];
  const writeRoutes = {
    reply: (opts?: any) => reply(CHANNEL, COMMENT, opts),
    hide: (opts?: any) => hide(CHANNEL, COMMENT, opts),
    remove: (opts?: any) => remove(CHANNEL, COMMENT, opts),
  };
  describe('without YSOCIAL_DEMO_INTEGRATIONS', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['only commas', ' , ,, '],
    ])('answers 404 on all four routes when it is %s', async (_n, value) => {
      if (value === undefined) {
        delete process.env[LIST_ENV];
      } else {
        process.env[LIST_ENV] = value;
      }
      // With the right token, a wrong one and none: 404 before the token check.
      for (const auth of [`Bearer ${serviceToken}`, 'Bearer wrong', '']) {
        for (const call of allRoutes({ auth })) {
          expect((await call()).status).toBe(404);
        }
      }
      nothingTouched();
      expect(logLines).toEqual([]);
    });
  });

  describe('auth', () => {
    it('answers 401 without or with a wrong token on all routes', async () => {
      for (const auth of ['', `Bearer ${randomBytes(32).toString('hex')}`]) {
        expect((await read(CHANNEL, { auth })).status).toBe(401);
        expect(
          (await reply(CHANNEL, COMMENT, { auth, body: bodies.reply })).status
        ).toBe(401);
        expect(
          (await hide(CHANNEL, COMMENT, { auth, body: bodies.hide })).status
        ).toBe(401);
        expect(
          (await remove(CHANNEL, COMMENT, { auth, body: bodies.remove })).status
        ).toBe(401);
      }
      nothingTouched();
    });

    it('answers 503 without a configured service token', async () => {
      delete process.env[TOKEN_ENV];
      expect((await read()).status).toBe(503);
      expect((await reply()).status).toBe(503);
      expect((await hide()).status).toBe(503);
      expect((await remove()).status).toBe(503);
      nothingTouched();
    });
  });

  describe('channel not listed', () => {
    it('answers 403 not_demo_integration on all routes without Graph or database call', async () => {
      const results = [
        await read(OTHER_CHANNEL),
        await reply(OTHER_CHANNEL),
        await hide(OTHER_CHANNEL),
        await remove(OTHER_CHANNEL),
      ];
      for (const res of results) {
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
      }
      nothingTouched();
      expect(logLines).toEqual([
        'inbox comments channel=- result=rejected code=not_demo_integration',
        `inbox reply channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
        `inbox hide channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
        `inbox delete channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
      ]);
    });

    it('does not accept a prefix of a listed id', async () => {
      process.env[LIST_ENV] = 'int-demo-12';
      expect((await read(CHANNEL)).status).toBe(403);
      nothingTouched();
    });

    it('logs a raw path as - when the channel is not listed', async () => {
      const res = await reply(OTHER_CHANNEL, '..%2Fme');
      expect(res.status).toBe(403);
      expect(logLines.join('\n')).toContain('comment=-');
      expect(logLines.join('\n')).not.toContain('..');
    });
  });

  describe('actor', () => {
    it.each([
      ['missing', null],
      ['spaces only', '   '],
      ['with a space inside', 'anna example'],
      ['too long', 'a'.repeat(201)],
    ])(
      'answers 400 actor_missing on every write route when it is %s',
      async (_n, actor) => {
        for (const [name, call] of Object.entries(writeRoutes)) {
          const res = await call({
            actor,
            body: bodies[name as keyof typeof bodies],
          });
          expect(res.status).toBe(400);
          expect(res.json()).toMatchObject({ code: 'actor_missing' });
        }
        nothingTouched();
      }
    );

    it('does not need an actor for reading', async () => {
      const res = await read(CHANNEL, { actor: null });
      expect(res.status).toBe(200);
    });
  });

  describe('body', () => {
    it.each([
      ['missing', {}],
      ['empty', { message: '' }],
      ['spaces only', { message: '   \n ' }],
      ['too long', { message: 'a'.repeat(2201) }],
      ['not a string', { message: 5 }],
    ])('rejects a reply with message %s', async (_n, body) => {
      const res = await reply(CHANNEL, COMMENT, { body });
      expect(res.status).toBe(400);
      nothingTouched();
    });

    it('accepts a message of exactly 2200 characters', async () => {
      const res = await reply(CHANNEL, COMMENT, {
        body: { message: 'a'.repeat(2200) },
      });
      expect(res.status).toBe(201);
      expect(writes()).toHaveLength(1);
    });

    it.each([
      ['missing', {}],
      ['a string', { hide: 'true' }],
      ['a number', { hide: 1 }],
      ['null', { hide: null }],
    ])('rejects hide that is %s', async (_n, body) => {
      const res = await hide(CHANNEL, COMMENT, { body });
      expect(res.status).toBe(400);
      nothingTouched();
    });

    it.each([
      ['a string', { confirmDelete: 'true' }],
      ['a number', { confirmDelete: 1 }],
    ])('rejects confirmDelete that is %s', async (_n, body) => {
      const res = await remove(CHANNEL, COMMENT, { body });
      expect(res.status).toBe(400);
      nothingTouched();
    });

    it('rejects an invalid JSON body', async () => {
      const res = await reply(CHANNEL, COMMENT, { raw: '{not json' });
      expect(res.status).toBe(400);
      nothingTouched();
    });
  });

  describe('delete confirmation', () => {
    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['confirmDelete false', { confirmDelete: false }],
    ])(
      'answers 409 confirmation_required with %s and calls no platform',
      async (_n, body) => {
        const res = await remove(CHANNEL, COMMENT, { body });
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'confirmation_required' });
        expect(graphCalls).toEqual([]);
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(logLines).toEqual([
          `inbox delete channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=confirmation_required`,
        ]);
      }
    );

    it('sends exactly one DELETE to Meta with confirmDelete true', async () => {
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        deleted: true,
      });
      expect(writes()).toHaveLength(1);
      expect(writes()[0].method).toBe('DELETE');
      expect(writes()[0].url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(logLines).toEqual([
        `inbox delete channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });
  });

  describe('checks of the channel and the comment', () => {
    it.each([
      ['a path with dots', '1.2'],
      ['letters', 'abc'],
    ])(
      'answers 400 invalid_comment_id for %s on every write route',
      async (_n, commentId) => {
        for (const call of [
          (id: string) => reply(CHANNEL, id),
          (id: string) => hide(CHANNEL, id),
          (id: string) => remove(CHANNEL, id),
        ]) {
          const res = await call(commentId);
          expect(res.status).toBe(400);
          expect(res.json()).toMatchObject({ code: 'invalid_comment_id' });
        }
        nothingTouched();
        expect(logLines).toHaveLength(3);
        for (const line of logLines) {
          expect(line).toContain('comment=- ');
          expect(line).not.toContain(commentId);
        }
      }
    );

    it('answers 404 comment_not_found for an id with "_" and calls no platform', async () => {
      const commentId = '17950000000000001_17950000000000002';
      for (const res of [
        await reply(CHANNEL, commentId),
        await hide(CHANNEL, commentId),
        await remove(CHANNEL, commentId),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      }
      expect(graphCalls).toEqual([]);
      expect(logLines).toHaveLength(3);
      for (const line of logLines) {
        expect(line).toContain('result=rejected code=comment_not_found');
      }
    });

    it('answers 404 not_found for an unknown channel', async () => {
      repository.getChannelForInbox.mockResolvedValue(null);
      for (const res of [
        await read(),
        await reply(),
        await hide(),
        await remove(),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
      }
      expect(graphCalls).toEqual([]);
    });

    it.each([
      ['deleted', { deletedAt: new Date() }, 'deleted'],
      ['disabled', { disabled: true }, 'disabled'],
      ['refreshNeeded', { refreshNeeded: true }, 'refresh_needed'],
      ['inBetweenSteps', { inBetweenSteps: true }, 'in_between_steps'],
    ])(
      'answers 409 channel_inactive for a %s channel',
      async (_n, patch, flag) => {
        repository.getChannelForInbox.mockResolvedValue(row(patch));
        for (const res of [
          await read(),
          await reply(),
          await hide(),
          await remove(),
        ]) {
          expect(res.status).toBe(409);
          expect(res.json()).toMatchObject({ code: 'channel_inactive', flag });
        }
        expect(graphCalls).toEqual([]);
      }
    );

    it.each(['facebook', 'instagram-standalone'])(
      'answers 409 provider_not_supported for %s',
      async (provider) => {
        repository.getChannelForInbox.mockResolvedValue(
          row({ providerIdentifier: provider })
        );
        for (const res of [
          await read(),
          await reply(),
          await hide(),
          await remove(),
        ]) {
          expect(res.status).toBe(409);
          expect(res.json()).toMatchObject({
            code: 'provider_not_supported',
            provider,
          });
        }
        expect(graphCalls).toEqual([]);
      }
    );

    it('reads the channel from the database exactly once per call', async () => {
      await hide();
      expect(repository.getChannelForInbox).toHaveBeenCalledTimes(1);
      expect(repository.getChannelForInbox).toHaveBeenCalledWith(CHANNEL);
    });
  });

  describe('comment on a foreign post', () => {
    it('answers 404 comment_not_found on every write route and writes nothing at Meta', async () => {
      for (const res of [
        await reply(CHANNEL, FOREIGN_COMMENT),
        await hide(CHANNEL, FOREIGN_COMMENT),
        await remove(CHANNEL, FOREIGN_COMMENT),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      }
      expect(writes()).toEqual([]);
      expect(graphCalls.length).toBeGreaterThan(0);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox hide channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox delete channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
      ]);
    });

    it('answers 404 comment_not_found for a comment Meta knows no media for', async () => {
      graphHandler = () => json({ id: COMMENT });
      const res = await remove();
      expect(res.status).toBe(404);
      expect(writes()).toEqual([]);
    });
  });

  describe('errors of the platform', () => {
    it('answers 502 platform_error with codes and a sanitized reason', async () => {
      const leaked = randomBytes(30).toString('hex');
      graphHandler = (call) =>
        call.method === 'POST'
          ? json(
              {
                error: {
                  message: `${META_MESSAGE} access_token=${pageToken} ${leaked}`,
                  code: 10,
                  error_subcode: 2207,
                },
              },
              400
            )
          : defaultGraph(call);
      const res = await reply();
      expect(res.status).toBe(502);
      const body = res.json();
      expect(body).toMatchObject({
        code: 'platform_error',
        platformStatus: 400,
        platformCode: 10,
        platformSubcode: 2207,
      });
      expect(body.reason).toContain('Erfundene Meldung von Meta');
      expect(body.reason).not.toContain(pageToken);
      expect(body.reason).not.toContain(leaked);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=platform_error status=400 platform=10/2207`,
      ]);
    });

    it('answers 502 for a failed read as well', async () => {
      graphHandler = () =>
        json({ error: { message: META_MESSAGE, code: 190 } }, 401);
      const res = await read();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 401,
        platformCode: 190,
        platformSubcode: null,
      });
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=rejected code=platform_error status=401 platform=190/-`,
      ]);
    });

    it('answers 502 when a hide or delete is not confirmed by Meta', async () => {
      graphHandler = (call) =>
        call.method === 'GET' ? defaultGraph(call) : json({ success: false });
      expect((await hide()).status).toBe(502);
      expect((await remove()).status).toBe(502);
    });

    it('answers 503 platform_unavailable when Meta is not reachable', async () => {
      graphHandler = () => {
        throw new Error(`fetch failed access_token=${pageToken}`);
      };
      for (const res of [
        await read(),
        await reply(),
        await hide(),
        await remove(),
      ]) {
        expect(res.status).toBe(503);
        expect(res.json()).toEqual({
          statusCode: 503,
          code: 'platform_unavailable',
        });
      }
      expect(logLines[0]).toBe(
        `inbox comments channel=${CHANNEL} result=rejected code=platform_unavailable`
      );
    });
  });

  describe('unknown outcome of a write', () => {
    const networkFailureOnWrite = () => {
      graphHandler = (call) => {
        if (call.method === 'GET') {
          return defaultGraph(call);
        }
        throw new Error(`fetch failed access_token=${pageToken}`);
      };
    };

    it('answers 503 outcome_unknown when the write itself gets no answer', async () => {
      networkFailureOnWrite();
      for (const [action, res] of [
        ['reply', await reply()],
        ['hide', await hide()],
        ['delete', await remove()],
      ] as const) {
        expect(res.status).toBe(503);
        expect(res.json()).toEqual({
          statusCode: 503,
          code: 'outcome_unknown',
        });
        expect(logLines).toContain(
          `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown`
        );
      }
      // One attempt each, no automatic repeat.
      expect(writes()).toHaveLength(3);
    });

    it('answers 503 platform_unavailable, not outcome_unknown, when the check before the write fails', async () => {
      graphHandler = () => {
        throw new Error('fetch failed');
      };
      for (const res of [await reply(), await hide(), await remove()]) {
        expect(res.status).toBe(503);
        expect(res.json()).toMatchObject({ code: 'platform_unavailable' });
      }
      expect(writes()).toEqual([]);
      for (const line of logLines) {
        expect(line).toContain('code=platform_unavailable');
      }
    });

    it('keeps 502 platform_error when Meta answers the write with an error', async () => {
      graphHandler = (call) =>
        call.method === 'GET'
          ? defaultGraph(call)
          : json({ error: { message: META_MESSAGE, code: 200 } }, 403);
      const res = await reply();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ code: 'platform_error' });
    });
  });

  describe('5xx of Meta on the write itself', () => {
    const writeCalls = [
      ['reply', () => reply()],
      ['hide', () => hide()],
      ['delete', () => remove()],
    ] as const;

    const metaFails = (status: number, onlyWrites = true) => {
      graphHandler = (call) =>
        onlyWrites && call.method === 'GET'
          ? defaultGraph(call)
          : json(
              {
                error: {
                  code: 2,
                  is_transient: true,
                  message: `${META_MESSAGE} ${REPLY_TEXT}`,
                },
              },
              status
            );
    };

    it.each([500, 502, 503, 599])(
      'answers 503 outcome_unknown on every write route for HTTP %s, one write each',
      async (status) => {
        metaFails(status);
        for (const [action, call] of writeCalls) {
          const res = await call();
          expect(res.status).toBe(503);
          expect(res.json()).toEqual({
            statusCode: 503,
            code: 'outcome_unknown',
          });
          // Neither the message of Meta nor a platform field in the answer.
          expect(res.text).not.toContain('Erfundene');
          expect(res.text).not.toContain('platform');
          expect(logLines).toContain(
            `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=${status} platform=2/-`
          );
        }
        // One attempt per route, no second try.
        expect(writes()).toHaveLength(3);
        expect(writes().map((call) => call.method)).toEqual([
          'POST',
          'POST',
          'DELETE',
        ]);
      }
    );

    it('logs the codes of Meta with a subcode', async () => {
      graphHandler = (call) =>
        call.method === 'GET'
          ? defaultGraph(call)
          : json({ error: { code: 1, error_subcode: 99, message: 'x' } }, 500);
      await reply();
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=500 platform=1/99`,
      ]);
    });

    it('logs status=500 platform=-/- when the error body has no codes', async () => {
      graphHandler = (call) =>
        call.method === 'GET' ? defaultGraph(call) : json({}, 500);
      const res = await hide();
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'outcome_unknown' });
      expect(logLines).toEqual([
        `inbox hide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=500 platform=-/-`,
      ]);
    });

    it.each([400, 401, 403, 404, 429])(
      'keeps 502 platform_error for HTTP %s on the write',
      async (status) => {
        metaFails(status);
        for (const [, call] of writeCalls) {
          const res = await call();
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({
            code: 'platform_error',
            platformStatus: status,
            platformCode: 2,
          });
        }
        expect(writes()).toHaveLength(3);
      }
    );

    it('keeps 502 platform_error for a 5xx on the read', async () => {
      metaFails(500, false);
      const res = await read();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 500,
        platformCode: 2,
      });
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=rejected code=platform_error status=500 platform=2/-`,
      ]);
    });

    it('keeps 502 platform_error for a 5xx on the ownership check, and writes nothing', async () => {
      metaFails(500, false);
      for (const [action, call] of writeCalls) {
        const res = await call();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({ code: 'platform_error' });
        expect(logLines).toContain(
          `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=platform_error status=500 platform=2/-`
        );
      }
      expect(writes()).toEqual([]);
    });
  });

  describe('unexpected errors', () => {
    class ErfundeterFehler extends Error {}
    class OddName extends Error {
      name = 'Odd Name! <script>';
    }
    const message = `Erfundener DB-Fehler mit ${REPLY_TEXT} und ${COMMENT_TEXT}`;

    const everyRoute = () =>
      [
        ['comments', () => read()],
        ['reply', () => reply()],
        ['hide', () => hide()],
        ['delete', () => remove()],
      ] as const;

    it.each([
      ['an Error', new Error(message), 'Error'],
      ['a custom class', new ErfundeterFehler(message), 'Error'],
      ['a name with special characters', new OddName(message), 'Error'],
      ['a thrown string', message, 'Error'],
    ])(
      'answers 500 internal_error for %s from the repository',
      async (_n, thrown, name) => {
        repository.getChannelForInbox.mockRejectedValue(thrown);
        for (const [action, call] of everyRoute()) {
          const res = await call();
          expect(res.status).toBe(500);
          expect(res.json()).toEqual({
            statusCode: 500,
            code: 'internal_error',
          });
          expect(res.text).not.toContain('Erfundener');
          const line = logLines.find((l) => l.startsWith(`inbox ${action} `));
          expect(line).toContain(
            `result=rejected code=internal_error error=${name}`
          );
        }
        expect(graphCalls).toEqual([]);
      }
    );

    it('logs the class name of an Error whose name is a plain word', async () => {
      class DbFehler extends Error {
        name = 'DbFehler';
      }
      repository.getChannelForInbox.mockRejectedValue(new DbFehler(message));
      await read();
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=rejected code=internal_error error=DbFehler`,
      ]);
    });

    describe('Prisma error code', () => {
      class PrismaClientKnownRequestError extends Error {
        name = 'PrismaClientKnownRequestError';
        constructor(readonly code: unknown) {
          super(message);
        }
      }

      it('logs a Prisma code like P1001 next to the class name', async () => {
        repository.getChannelForInbox.mockRejectedValue(
          new PrismaClientKnownRequestError('P1001')
        );
        for (const [action, call] of everyRoute()) {
          const res = await call();
          expect(res.status).toBe(500);
          expect(res.json()).toEqual({
            statusCode: 500,
            code: 'internal_error',
          });
          const line = logLines.find((l) => l.startsWith(`inbox ${action} `));
          expect(line).toMatch(
            / result=rejected code=internal_error error=PrismaClientKnownRequestError code=P1001$/
          );
        }
      });

      it('logs the code for a plain Error with a Prisma code as well', async () => {
        repository.getChannelForInbox.mockRejectedValue(
          Object.assign(new Error(message), { code: 'P2025' })
        );
        await read();
        expect(logLines).toEqual([
          `inbox comments channel=${CHANNEL} result=rejected code=internal_error error=Error code=P2025`,
        ]);
      });

      it.each([
        ['ECONNRESET', 'ECONNRESET'],
        ['P1', 'P1'],
        ['a number', 1001],
        ['a code with a suffix', 'P1001; x'],
        ['too many digits', 'P10012'],
        ['lower case', 'p1001'],
        ['a leading space', ' P1001'],
        ['a line break', 'P1001\nx'],
        ['an object', { code: 'P1001' }],
        ['null', null],
      ])('does not log a code that is %s', async (_n, code) => {
        repository.getChannelForInbox.mockRejectedValue(
          Object.assign(new Error(message), { code })
        );
        const res = await read();
        expect(res.status).toBe(500);
        expect(logLines).toEqual([
          `inbox comments channel=${CHANNEL} result=rejected code=internal_error error=Error`,
        ]);
      });
    });

    it('keeps the status of HttpExceptions', async () => {
      repository.getChannelForInbox.mockResolvedValue(null);
      expect((await read()).status).toBe(404);
      repository.getChannelForInbox.mockResolvedValue(
        row({ providerIdentifier: 'facebook' })
      );
      expect((await reply()).status).toBe(409);
    });
  });

  describe('success', () => {
    it('reads the comments in the shape of the README', async () => {
      const res = await read();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(Date.parse(body.fetchedAt)).not.toBeNaN();
      expect(body).toEqual({
        integrationId: CHANNEL,
        provider: 'instagram',
        fetchedAt: body.fetchedAt,
        posts: [
          {
            id: MEDIA,
            permalink: 'https://www.instagram.com/p/ERFUNDEN/',
            timestamp: '2026-11-01T10:00:00+0000',
            mediaType: 'IMAGE',
            commentsCount: 2,
            comments: [
              {
                id: COMMENT,
                text: COMMENT_TEXT,
                username: COMMENTER,
                timestamp: '2026-11-02T10:00:00+0000',
                likeCount: 2,
                hidden: false,
                replies: [
                  {
                    id: REPLY_ID,
                    text: REPLY_TEXT,
                    username: 'konto',
                    timestamp: '2026-11-02T11:00:00+0000',
                    likeCount: 0,
                    hidden: false,
                  },
                ],
              },
            ],
          },
          {
            id: FOREIGN_MEDIA,
            permalink: null,
            timestamp: null,
            mediaType: null,
            commentsCount: 0,
            comments: [],
          },
        ],
      });
      expect(writes()).toEqual([]);
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=ok posts=2 comments=2`,
      ]);
    });

    it('replies with 201 and one POST to Meta, the text only in the body', async () => {
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        replyId: REPLY_ID,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('POST');
      expect(write.url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}/replies`
      );
      expect(write.url.search).toBe('');
      expect(write.body?.get('message')).toBe(REPLY_TEXT);
      expect(write.body?.get('access_token')).toBe(pageToken);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('hides with 200 and hidden true', async () => {
      const res = await hide();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        hidden: true,
      });
      expect(writes()).toHaveLength(1);
      expect(writes()[0].body?.get('hide')).toBe('true');
      expect(logLines).toEqual([
        `inbox hide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('shows a comment again with {"hide": false} and logs unhide', async () => {
      const res = await hide(CHANNEL, COMMENT, { body: { hide: false } });
      expect(res.status).toBe(200);
      expect(res.json()).toMatchObject({ hidden: false });
      expect(writes()).toHaveLength(1);
      expect(writes()[0].body?.get('hide')).toBe('false');
      expect(logLines).toEqual([
        `inbox unhide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('sends only the page token to Meta, never the user token', async () => {
      await read();
      await reply();
      await hide();
      await remove();
      expect(graphCalls.length).toBeGreaterThan(4);
      for (const call of graphCalls) {
        expect(call.url.host).toBe('graph.facebook.com');
        const sent =
          call.body?.get('access_token') ??
          call.url.searchParams.get('access_token');
        expect(sent).toBe(pageToken);
        expect(`${call.url}${call.body ?? ''}`).not.toContain(userToken);
      }
    });

    it('returns replyId null when Meta sends no id', async () => {
      graphHandler = (call) =>
        call.method === 'POST' ? json({}) : defaultGraph(call);
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json().replyId).toBeNull();
    });
  });
});
