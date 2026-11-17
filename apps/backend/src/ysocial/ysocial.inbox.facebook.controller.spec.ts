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
// The Page token is the whole Integration.token of "facebook".
const pageToken = randomBytes(24).toString('hex');

// Invented data only. Posts and comments of a Page are <digits>_<digits>.
const CHANNEL = 'int-demo-fb-1';
const OTHER_CHANNEL = 'int-other-fb-1';
const PAGE = '100000000000001';
const POST = `${PAGE}_200000000000001`;
const FOREIGN_POST = `${PAGE}_200000000000009`;
const COMMENT = '200000000000001_300000000000001';
const FOREIGN_COMMENT = '200000000000009_300000000000009';
const REPLY_ID = '300000000000001_400000000000001';
const NEW_REPLY_ID = '300000000000001_400000000000002';
const ACTOR = 'anna@example.com';
const COMMENT_TEXT = 'Erfundener Kommentar';
const COMMENTER = 'Erfundene Person';
const COMMENTER_ID = '500000000000777';
const REPLY_TEXT = 'Erfundene Antwort des Kontos';
const META_MESSAGE = 'Erfundene Meldung von Meta, nie im Log';

const row = (patch: Record<string, unknown> = {}): any => ({
  id: CHANNEL,
  providerIdentifier: 'facebook',
  internalId: PAGE,
  token: pageToken,
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

// The platform: one own post with a comment that has a reply, and a post
// with no comments. FOREIGN_COMMENT is listed nowhere.
const defaultGraph = ({ method, url }: GraphCall): Response => {
  const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
  if (method === 'GET' && path === `/${PAGE}/published_posts`) {
    return json({
      data: [
        {
          id: POST,
          permalink_url: 'https://www.facebook.com/erfunden/posts/1',
          created_time: '2026-11-01T10:00:00+0000',
          status_type: 'added_photos',
        },
        { id: FOREIGN_POST },
      ],
    });
  }
  if (method === 'GET' && path === `/${POST}/comments`) {
    return json({
      data: [
        {
          id: COMMENT,
          message: COMMENT_TEXT,
          from: { name: COMMENTER, id: COMMENTER_ID },
          created_time: '2026-11-02T10:00:00+0000',
          like_count: 2,
          is_hidden: false,
          comments: {
            data: [
              {
                id: REPLY_ID,
                message: REPLY_TEXT,
                from: { name: 'Erfundene Seite', id: '500000000000888' },
                created_time: '2026-11-02T11:00:00+0000',
                like_count: 0,
                is_hidden: false,
              },
            ],
          },
        },
      ],
      summary: { total_count: 2 },
    });
  }
  if (method === 'GET' && path === `/${FOREIGN_POST}/comments`) {
    return json({ data: [], summary: { total_count: 0 } });
  }
  if (
    method === 'POST' &&
    (path === `/${COMMENT}/comments` || path === `/${REPLY_ID}/comments`)
  ) {
    return json({ id: NEW_REPLY_ID });
  }
  if (
    method === 'POST' &&
    (path === `/${COMMENT}` || path === `/${REPLY_ID}`)
  ) {
    return json({ success: true });
  }
  if (
    method === 'DELETE' &&
    (path === `/${COMMENT}` || path === `/${REPLY_ID}`)
  ) {
    return json({ success: true });
  }
  return json({ error: { message: 'unexpected call', code: 1 } }, 400);
};

describe('/ysocial/inbox with a Facebook Page', () => {
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

    // Privacy, in every case, errors included: no comment text, name, id of
    // the person, reply text, token or message of the platform in a log line,
    // no token in an answer, and the id of the person in no answer either.
    const secrets = [
      COMMENT_TEXT,
      COMMENTER,
      COMMENTER_ID,
      REPLY_TEXT,
      META_MESSAGE,
      pageToken,
      serviceToken,
    ];
    const log = logLines.join('\n');
    for (const secret of secrets) {
      expect(log).not.toContain(secret);
    }
    for (const text of responses) {
      for (const secret of [pageToken, serviceToken, COMMENTER_ID]) {
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
    }: {
      auth?: string;
      actor?: string | null;
      body?: unknown;
    } = {}
  ) => {
    const hasBody = body !== undefined;
    const res = await fetch(`${baseUrl}/ysocial/inbox${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(actor ? { 'x-ysocial-actor': actor } : {}),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    responses.push(text);
    return {
      status: res.status,
      text,
      json: () => (text ? JSON.parse(text) : undefined),
    };
  };

  const read = (id = CHANNEL) => request('GET', `/integrations/${id}/comments`);
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
  const path = (call: GraphCall) =>
    call.url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');

  describe('read', () => {
    it('reads the comments in the shape of the README', async () => {
      const res = await read();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(Date.parse(body.fetchedAt)).not.toBeNaN();
      expect(body).toEqual({
        integrationId: CHANNEL,
        provider: 'facebook',
        fetchedAt: body.fetchedAt,
        posts: [
          {
            id: POST,
            permalink: 'https://www.facebook.com/erfunden/posts/1',
            timestamp: '2026-11-01T10:00:00+0000',
            mediaType: 'added_photos',
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
                    username: 'Erfundene Seite',
                    timestamp: '2026-11-02T11:00:00+0000',
                    likeCount: 0,
                    hidden: false,
                  },
                ],
              },
            ],
          },
          {
            id: FOREIGN_POST,
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

    it('sends the Page token from the database row to Meta, in the query', async () => {
      await read();
      expect(graphCalls.length).toBe(3);
      for (const call of graphCalls) {
        expect(call.method).toBe('GET');
        expect(call.url.searchParams.get('access_token')).toBe(pageToken);
      }
    });
  });

  describe('reply', () => {
    it('replies with 201 and one POST to /{comment}/comments, the text only in the body', async () => {
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        replyId: NEW_REPLY_ID,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('POST');
      expect(write.url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}/comments`
      );
      expect(write.url.search).toBe('');
      expect(write.body?.get('message')).toBe(REPLY_TEXT);
      expect(write.body?.get('access_token')).toBe(pageToken);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
      // The text of the reply is nowhere in a URL.
      for (const call of graphCalls) {
        expect(String(call.url)).not.toContain('Erfundene');
      }
    });

    it('lets a reply to a reply that the list contains through', async () => {
      const res = await reply(CHANNEL, REPLY_ID);
      expect(res.status).toBe(201);
      expect(writes()).toHaveLength(1);
      expect(path(writes()[0])).toBe(`/${REPLY_ID}/comments`);
    });

    it('returns replyId null when Meta sends no id', async () => {
      graphHandler = (call) =>
        call.method === 'POST' ? json({}) : defaultGraph(call);
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json().replyId).toBeNull();
    });

    it('answers 400 for an empty message and touches nothing', async () => {
      const res = await reply(CHANNEL, COMMENT, { body: { message: '  ' } });
      expect(res.status).toBe(400);
      expect(graphCalls).toEqual([]);
      expect(repository.getChannelForInbox).not.toHaveBeenCalled();
    });
  });

  describe('hide and show again', () => {
    it('hides with 200 and is_hidden=true, one POST', async () => {
      const res = await hide();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        hidden: true,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('POST');
      expect(path(write)).toBe(`/${COMMENT}`);
      expect(write.url.search).toBe('');
      expect(write.body?.get('is_hidden')).toBe('true');
      expect(write.body?.get('access_token')).toBe(pageToken);
      expect(logLines).toEqual([
        `inbox hide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('shows a comment again with {"hide": false}, is_hidden=false, logs unhide', async () => {
      const res = await hide(CHANNEL, COMMENT, { body: { hide: false } });
      expect(res.status).toBe(200);
      expect(res.json()).toMatchObject({ hidden: false });
      expect(writes()).toHaveLength(1);
      expect(writes()[0].body?.get('is_hidden')).toBe('false');
      expect(logLines).toEqual([
        `inbox unhide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('answers 502 when Meta does not confirm with success: true', async () => {
      graphHandler = (call) =>
        call.method === 'GET' ? defaultGraph(call) : json({ success: false });
      const res = await hide();
      expect(res.status).toBe(502);
      expect(writes()).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['confirmDelete false', { confirmDelete: false }],
    ])(
      'answers 409 confirmation_required with %s and calls neither Meta nor the database',
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

    it('sends exactly one DELETE with confirmDelete true, the token in the query', async () => {
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        deleted: true,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('DELETE');
      expect(path(write)).toBe(`/${COMMENT}`);
      expect(write.body).toBeNull();
      expect(write.url.searchParams.get('access_token')).toBe(pageToken);
      expect(logLines).toEqual([
        `inbox delete channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('answers 502 when Meta does not confirm with success: true', async () => {
      graphHandler = (call) =>
        call.method === 'GET' ? defaultGraph(call) : json({});
      const res = await remove();
      expect(res.status).toBe(502);
      expect(writes()).toHaveLength(1);
    });
  });

  describe('comment that the list does not contain', () => {
    it('answers 404 comment_not_found on every write route and writes nothing', async () => {
      for (const res of [
        await reply(CHANNEL, FOREIGN_COMMENT),
        await hide(CHANNEL, FOREIGN_COMMENT),
        await remove(CHANNEL, FOREIGN_COMMENT),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      }
      expect(writes()).toEqual([]);
      // The check read the list of the Page.
      expect(graphCalls.length).toBeGreaterThan(0);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox hide channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox delete channel=${CHANNEL} comment=${FOREIGN_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
      ]);
    });

    it('answers 404 for the id of a post, which is no comment of the list', async () => {
      for (const res of [
        await reply(CHANNEL, POST),
        await hide(CHANNEL, POST),
        await remove(CHANNEL, POST),
      ]) {
        expect(res.status).toBe(404);
      }
      expect(writes()).toEqual([]);
    });

    it('answers 404 when the channel has no posts at all', async () => {
      graphHandler = () => json({ data: [] });
      const res = await remove();
      expect(res.status).toBe(404);
      expect(writes()).toEqual([]);
    });
  });

  describe('channel not listed', () => {
    it('answers 403 not_demo_integration on all routes without Meta or database call', async () => {
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
      expect(graphCalls).toEqual([]);
      expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      expect(logLines).toEqual([
        'inbox comments channel=- result=rejected code=not_demo_integration',
        `inbox reply channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
        `inbox hide channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
        `inbox delete channel=- comment=${COMMENT} actor=${ACTOR} result=rejected code=not_demo_integration`,
      ]);
    });
  });

  describe('Meta fails', () => {
    const networkFailureOnWrite = () => {
      graphHandler = (call) => {
        if (call.method === 'GET') {
          return defaultGraph(call);
        }
        throw new Error(`fetch failed access_token=${pageToken}`);
      };
    };

    it('answers 503 outcome_unknown when a write gets no answer, one attempt each', async () => {
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
      expect(writes().map((call) => call.method)).toEqual([
        'POST',
        'POST',
        'DELETE',
      ]);
    });

    it.each([500, 502, 503, 599])(
      'answers 503 outcome_unknown for HTTP %s on a write, one attempt each, no text of Meta',
      async (status) => {
        graphHandler = (call) =>
          call.method === 'GET'
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
        for (const [action, call] of [
          ['reply', () => reply()],
          ['hide', () => hide()],
          ['delete', () => remove()],
        ] as const) {
          const res = await call();
          expect(res.status).toBe(503);
          expect(res.json()).toEqual({
            statusCode: 503,
            code: 'outcome_unknown',
          });
          expect(res.text).not.toContain('Erfundene');
          expect(logLines).toContain(
            `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=${status} platform=2/-`
          );
        }
        expect(writes()).toHaveLength(3);
      }
    );

    it('keeps 502 platform_error with a sanitized reason when Meta refuses a write', async () => {
      const leaked = randomBytes(30).toString('hex');
      graphHandler = (call) =>
        call.method === 'POST'
          ? json(
              {
                error: {
                  message: `${META_MESSAGE} access_token=${pageToken} ${leaked}`,
                  code: 200,
                  error_subcode: 1446036,
                },
              },
              403
            )
          : defaultGraph(call);
      const res = await reply();
      expect(res.status).toBe(502);
      const body = res.json();
      expect(body).toMatchObject({
        code: 'platform_error',
        platformStatus: 403,
        platformCode: 200,
        platformSubcode: 1446036,
      });
      expect(body.reason).not.toContain(pageToken);
      expect(body.reason).not.toContain(leaked);
      expect(writes()).toHaveLength(1);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=platform_error status=403 platform=200/1446036`,
      ]);
    });

    it('does not write when the check before the write gets no answer', async () => {
      graphHandler = () => {
        throw new Error(`fetch failed access_token=${pageToken}`);
      };
      for (const res of [await reply(), await hide(), await remove()]) {
        expect(res.status).toBe(503);
        expect(res.json()).toMatchObject({ code: 'platform_unavailable' });
      }
      expect(writes()).toEqual([]);
    });

    it('does not write when Meta answers the check with an error', async () => {
      graphHandler = () =>
        json({ error: { message: META_MESSAGE, code: 190 } }, 401);
      for (const res of [await reply(), await hide(), await remove()]) {
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 401,
          platformCode: 190,
        });
      }
      expect(writes()).toEqual([]);
    });

    it('does not write when Meta answers the check with a 5xx', async () => {
      graphHandler = () =>
        json({ error: { message: META_MESSAGE, code: 2 } }, 500);
      for (const res of [await reply(), await hide(), await remove()]) {
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({ code: 'platform_error' });
      }
      expect(writes()).toEqual([]);
    });

    it('answers 502 for a failed read', async () => {
      graphHandler = () =>
        json({ error: { message: META_MESSAGE, code: 190 } }, 401);
      const res = await read();
      expect(res.status).toBe(502);
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=rejected code=platform_error status=401 platform=190/-`,
      ]);
    });
  });

  describe('channel of another provider', () => {
    it('answers 409 provider_not_supported for a provider without an inbox', async () => {
      repository.getChannelForInbox.mockResolvedValue(
        row({ providerIdentifier: 'linkedin' })
      );
      const res = await read();
      expect(res.status).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'provider_not_supported',
        provider: 'linkedin',
      });
      expect(graphCalls).toEqual([]);
    });
  });
});
