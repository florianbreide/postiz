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
import { YsocialWebhookRepository } from '../../../../libraries/ysocial/src/database/ysocial.webhook.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialAutomationRepository } from '../../../../libraries/ysocial/src/database/ysocial.automation.repository';
import { YsocialAutomationCheck } from '../../../../libraries/ysocial/src/automation/ysocial.automation.check';

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
const EMPTY_POST = `${PAGE}_200000000000009`;
const COMMENT = '200000000000001_300000000000001';
const UNLISTED_COMMENT = '200000000000009_300000000000009';
const REPLY_ID = '300000000000001_400000000000001';
const NEW_REPLY_ID = '300000000000001_400000000000002';
const ACTOR = 'anna@example.com';
const COMMENT_TEXT = 'Erfundener Kommentar';
const COMMENTER = 'Erfundene Person';
const COMMENTER_ID = '500000000000777';
const REPLY_TEXT = 'Erfundene Antwort des Kontos';
const META_MESSAGE = 'Erfundene Meldung von Meta, nie im Log';
// Names tagged in a comment (W76): never in a log line.
const MENTION_PERSON = 'Erika Beispiel';
const MENTION_ID = '600000000000001';

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

// A 2xx that is not a JSON object: nothing the platform sent can be read.
const unreadable = [
  ['an empty body', () => new Response('', { status: 200 })],
  ['a 204', () => new Response(null, { status: 204 })],
  ['HTML', () => new Response('<html>Erfunden</html>', { status: 200 })],
  ['a cut off body', () => new Response('{"success": tr', { status: 200 })],
  ['the bare value true', () => new Response('true', { status: 200 })],
  ['an array', () => new Response('[]', { status: 200 })],
] as const;

type GraphCall = { method: string; url: URL; body: URLSearchParams | null };
const graphCalls: GraphCall[] = [];
let graphHandler: (call: GraphCall) => Response | Promise<Response>;

// One top-level comment with one reply.
const thread = () => ({
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
});

// The platform: one own post with a comment that has a reply, and a post
// with no comments. UNLISTED_COMMENT is listed nowhere. The window read
// (fields with comments) gets the comments embedded and a post of
// yesterday, because the window is the last 30 days of the real clock.
const defaultGraph = ({ method, url }: GraphCall): Response => {
  const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
  if (method === 'GET' && path === `/${PAGE}/published_posts`) {
    if (url.searchParams.get('fields')?.includes('comments')) {
      return json({
        data: [
          {
            id: POST,
            permalink_url: 'https://www.facebook.com/erfunden/posts/1',
            created_time: new Date(Date.now() - 86_400_000).toISOString(),
            status_type: 'added_photos',
            comments: { data: [thread()] },
          },
          { id: EMPTY_POST, comments: { data: [] } },
        ],
      });
    }
    return json({
      data: [
        {
          id: POST,
          permalink_url: 'https://www.facebook.com/erfunden/posts/1',
          created_time: '2026-11-01T10:00:00+0000',
          status_type: 'added_photos',
        },
        { id: EMPTY_POST },
      ],
    });
  }
  if (method === 'GET' && path === `/${POST}/comments`) {
    return json({ data: [thread()], summary: { total_count: 2 } });
  }
  if (method === 'GET' && path === `/${EMPTY_POST}/comments`) {
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
      .overrideProvider(YsocialAutomationRepository)
      .useValue({})
      .overrideProvider(YsocialAutomationCheck)
      .useValue({})
      .overrideProvider(YsocialInboxRepository)
      .useValue(repository)
      .overrideProvider(YsocialWebhookRepository)
      .useValue({})
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
      MENTION_PERSON,
      MENTION_ID,
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
                fromOwner: false,
                mentions: [],
                replies: [
                  {
                    id: REPLY_ID,
                    text: REPLY_TEXT,
                    username: 'Erfundene Seite',
                    timestamp: '2026-11-02T11:00:00+0000',
                    likeCount: 0,
                    hidden: false,
                    fromOwner: false,
                    mentions: [],
                  },
                ],
              },
            ],
          },
          {
            id: EMPTY_POST,
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

  describe('mentions (W76)', () => {
    it('answers the names of message_tags, no ids, and logs no name', async () => {
      graphHandler = (call) => {
        const res = defaultGraph(call);
        if (!call.url.pathname.endsWith(`/${POST}/comments`)) {
          return res;
        }
        return json({
          data: [
            {
              ...thread(),
              message_tags: [
                {
                  id: MENTION_ID,
                  name: MENTION_PERSON,
                  type: 'user',
                  offset: 0,
                  length: 14,
                },
              ],
            },
          ],
          summary: { total_count: 2 },
        });
      };
      const res = await read();
      expect(res.status).toBe(200);
      const top = res.json().posts[0].comments[0];
      // The tag also covers the first 14 characters of the text.
      expect(top.mentions).toEqual([MENTION_PERSON, 'Erfundener Kom']);
      expect(top.replies[0].mentions).toEqual([]);
      expect(res.text).not.toContain(MENTION_ID);
      expect(res.text).not.toContain('message_tags');
      expect(logLines).toEqual([
        `inbox comments channel=${CHANNEL} result=ok posts=2 comments=2`,
      ]);
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
        await reply(CHANNEL, UNLISTED_COMMENT),
        await hide(CHANNEL, UNLISTED_COMMENT),
        await remove(CHANNEL, UNLISTED_COMMENT),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      }
      expect(writes()).toEqual([]);
      // The check read the list of the Page.
      expect(graphCalls.length).toBeGreaterThan(0);
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${UNLISTED_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox hide channel=${CHANNEL} comment=${UNLISTED_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
        `inbox delete channel=${CHANNEL} comment=${UNLISTED_COMMENT} actor=${ACTOR} result=rejected code=comment_not_found`,
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

  describe('2xx without a readable body', () => {
    const isWrite = (call: GraphCall) => call.method !== 'GET';
    const writeUnreadable = (make: () => Response) => {
      graphHandler = (call) => (isWrite(call) ? make() : defaultGraph(call));
    };

    it.each(unreadable)(
      'answers 503 outcome_unknown on every write route for %s, one write each',
      async (_name, make) => {
        writeUnreadable(make);
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
          expect(res.text).not.toContain('Erfunden');
          expect(res.text).not.toContain('platform');
          expect(logLines).toContain(
            `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=${
              make().status
            } platform=-/- body=unreadable`
          );
        }
        // One attempt per route, no second try.
        expect(writes().map((call) => call.method)).toEqual([
          'POST',
          'POST',
          'DELETE',
        ]);
      }
    );

    it('logs body=unreadable once per call, with no token and no text', async () => {
      writeUnreadable(() => new Response('', { status: 200 }));
      await reply();
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=outcome_unknown status=200 platform=-/- body=unreadable`,
      ]);
    });

    it.each(unreadable)(
      'answers 502 platform_error when reading the comments gets %s',
      async (_name, make) => {
        graphHandler = (call) =>
          call.method === 'GET' &&
          call.url.pathname.endsWith(`/${POST}/comments`)
            ? make()
            : defaultGraph(call);
        const res = await read();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: make().status,
          reason: 'Die Plattform hat keine lesbare Antwort geschickt.',
        });
        expect(logLines).toEqual([
          `inbox comments channel=${CHANNEL} result=rejected code=platform_error status=${
            make().status
          } platform=-/- body=unreadable`,
        ]);
      }
    );

    it('answers 502 platform_error when the list of posts is unreadable', async () => {
      graphHandler = (call) =>
        call.url.pathname.endsWith(`/${PAGE}/published_posts`)
          ? new Response('', { status: 200 })
          : defaultGraph(call);
      const res = await read();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ code: 'platform_error' });
    });

    it.each(unreadable)(
      'answers 502 and does not write when the check of the comment gets %s',
      async (_name, make) => {
        graphHandler = (call) =>
          call.method === 'GET' &&
          call.url.pathname.endsWith(`/${PAGE}/published_posts`)
            ? make()
            : defaultGraph(call);
        for (const [action, call] of [
          ['reply', () => reply()],
          ['hide', () => hide()],
          ['delete', () => remove()],
        ] as const) {
          const res = await call();
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({
            code: 'platform_error',
            platformStatus: make().status,
            reason: 'Die Plattform hat keine lesbare Antwort geschickt.',
          });
          expect(logLines).toContain(
            `inbox ${action} channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=platform_error status=${
              make().status
            } platform=-/- body=unreadable`
          );
        }
        expect(writes()).toEqual([]);
      }
    );

    it('keeps 502 platform_error for {"success": false} on every write route', async () => {
      writeUnreadable(() => json({ success: false }));
      for (const call of [() => hide(), () => remove()]) {
        const res = await call();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 200,
        });
      }
      expect(logLines.join('\n')).not.toContain('unreadable');
      expect(writes()).toHaveLength(2);
    });

    it('keeps 502 platform_error for a 4xx with an unreadable body on the write', async () => {
      writeUnreadable(
        () => new Response('<html>Erfunden</html>', { status: 400 })
      );
      for (const call of [() => reply(), () => hide(), () => remove()]) {
        const res = await call();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 400,
        });
      }
      expect(logLines.join('\n')).not.toContain('unreadable');
    });

    it('keeps a readable {} on reply as done with replyId null', async () => {
      graphHandler = (call) =>
        call.method === 'POST' ? json({}) : defaultGraph(call);
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json().replyId).toBeNull();
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

  describe('webhooks of the Page', () => {
    const APP_ID_ENV = 'FACEBOOK_APP_ID';
    const APP_ID = '900000000000001';
    const FOREIGN_APP_ID = '900000000000002';
    const FOREIGN_APP_NAME = 'Erfundene Fremde App';
    const OWN_APP_NAME = 'Erfundene Eigene App';
    const NODE = PAGE;
    const EDGE = `${NODE}/subscribed_apps`;
    const savedAppId = process.env[APP_ID_ENV];

    const getWebhooks = (id = CHANNEL) =>
      request('GET', `/integrations/${id}/webhooks`);
    const subscribe = (
      id = CHANNEL,
      opts: Parameters<typeof request>[2] = {}
    ) => request('POST', `/integrations/${id}/webhooks`, opts);
    const edgeCalls = () =>
      graphCalls.filter((call) => path(call) === `/${EDGE}`);

    const platform = (data: unknown[]) => {
      graphHandler = (call) =>
        call.method === 'GET' && path(call) === `/${EDGE}`
          ? json({ data })
          : defaultGraph(call);
    };
    const ownApp = (fields: unknown[] = ['feed']) => ({
      id: APP_ID,
      name: OWN_APP_NAME,
      link: 'https://www.facebook.com/games/?app_id=900000000000001',
      subscribed_fields: fields,
    });
    const foreignApp = {
      id: FOREIGN_APP_ID,
      name: FOREIGN_APP_NAME,
      subscribed_fields: ['feed', 'messages'],
    };

    beforeEach(() => {
      process.env[APP_ID_ENV] = APP_ID;
      // Meta accepts the subscription unless a test says otherwise.
      graphHandler = (call) =>
        call.method === 'POST' && path(call) === `/${EDGE}`
          ? json({ success: true })
          : defaultGraph(call);
    });

    afterEach(() => {
      if (savedAppId === undefined) {
        delete process.env[APP_ID_ENV];
      } else {
        process.env[APP_ID_ENV] = savedAppId;
      }
      // The answers of both routes carry no id and no name of another app.
      for (const text of responses) {
        expect(text).not.toContain(FOREIGN_APP_ID);
        expect(text).not.toContain(FOREIGN_APP_NAME);
        expect(text).not.toContain(OWN_APP_NAME);
      }
    });

    describe('GET /integrations/:id/webhooks', () => {
      it('is subscribed when our app is on the Page, with the filtered fields', async () => {
        platform([
          foreignApp,
          ownApp(['feed', 'Bad Field', 'mention', 7, null, 'x'.repeat(41)]),
        ]);
        const res = await getWebhooks();
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
          integrationId: CHANNEL,
          provider: 'facebook',
          subscribed: true,
          fields: ['feed', 'mention'],
        });
        expect(graphCalls).toHaveLength(1);
        expect(graphCalls[0].method).toBe('GET');
        expect(path(graphCalls[0])).toBe(`/${EDGE}`);
        expect(graphCalls[0].url.searchParams.get('access_token')).toBe(
          pageToken
        );
        expect(logLines).toEqual([
          `inbox webhooks channel=${CHANNEL} result=ok subscribed=true fields=feed,mention`,
        ]);
      });

      it('is subscribed with no fields when our app has none', async () => {
        platform([{ id: APP_ID }, { ...ownApp(), id: FOREIGN_APP_ID }]);
        const res = await getWebhooks();
        expect(res.json()).toMatchObject({ subscribed: true, fields: [] });
        expect(logLines).toEqual([
          `inbox webhooks channel=${CHANNEL} result=ok subscribed=true fields=-`,
        ]);
      });

      it('is not subscribed when only foreign apps are on the Page', async () => {
        platform([foreignApp]);
        const res = await getWebhooks();
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
          integrationId: CHANNEL,
          provider: 'facebook',
          subscribed: false,
          fields: [],
        });
      });

      it('is not subscribed when no app is on the Page or Meta sends no data', async () => {
        for (const data of [[], undefined] as (unknown[] | undefined)[]) {
          graphHandler = (call) =>
            call.method === 'GET' && path(call) === `/${EDGE}`
              ? json(data === undefined ? {} : { data })
              : defaultGraph(call);
          const res = await getWebhooks();
          expect(res.status).toBe(200);
          expect(res.json()).toMatchObject({ subscribed: false, fields: [] });
        }
      });

      it('is not subscribed without FACEBOOK_APP_ID, even with an app on the Page', async () => {
        platform([ownApp(), foreignApp]);
        for (const value of [undefined, '']) {
          if (value === undefined) {
            delete process.env[APP_ID_ENV];
          } else {
            process.env[APP_ID_ENV] = value;
          }
          const res = await getWebhooks();
          expect(res.status).toBe(200);
          expect(res.json()).toMatchObject({ subscribed: false, fields: [] });
        }
      });

      it('compares the id of the app exactly, also when Meta sends a number', async () => {
        platform([{ ...ownApp(), id: Number(APP_ID) }]);
        expect((await getWebhooks()).json().subscribed).toBe(true);
        platform([{ ...ownApp(), id: `${APP_ID}0` }]);
        expect((await getWebhooks()).json().subscribed).toBe(false);
      });

      it('writes nothing', async () => {
        platform([ownApp()]);
        await getWebhooks();
        expect(writes()).toEqual([]);
      });

      it('answers 401 without a token and 404 without the demo list', async () => {
        const noAuth = await request(
          'GET',
          `/integrations/${CHANNEL}/webhooks`,
          {
            auth: '',
          }
        );
        expect(noAuth.status).toBe(401);
        delete process.env[LIST_ENV];
        expect((await getWebhooks()).status).toBe(404);
        expect(graphCalls).toEqual([]);
      });

      it('answers 403 for a channel that is not listed, without a call', async () => {
        const res = await getWebhooks(OTHER_CHANNEL);
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        expect(graphCalls).toEqual([]);
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      });

      it('answers 409 channel_inactive for a disabled channel, without a call', async () => {
        repository.getChannelForInbox.mockResolvedValue(
          row({ disabled: true })
        );
        const res = await getWebhooks();
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'channel_inactive' });
        expect(graphCalls).toEqual([]);
      });

      it('answers 502 for a refusal of Meta and 503 for a network error', async () => {
        graphHandler = () =>
          json({ error: { message: META_MESSAGE, code: 190 } }, 401);
        const refused = await getWebhooks();
        expect(refused.status).toBe(502);
        expect(refused.json()).toMatchObject({
          code: 'platform_error',
          platformCode: 190,
        });
        graphHandler = () => {
          throw new Error(`fetch failed access_token=${pageToken}`);
        };
        const down = await getWebhooks();
        expect(down.status).toBe(503);
        expect(down.json()).toMatchObject({ code: 'platform_unavailable' });
        expect(logLines).toEqual([
          `inbox webhooks channel=${CHANNEL} result=rejected code=platform_error status=401 platform=190/-`,
          `inbox webhooks channel=${CHANNEL} result=rejected code=platform_unavailable`,
        ]);
      });
    });

    describe('POST /integrations/:id/webhooks', () => {
      it('subscribes the app with one POST, the fields and the token in the body', async () => {
        const res = await subscribe();
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
          integrationId: CHANNEL,
          provider: 'facebook',
          subscribed: true,
          fields: ['feed'],
        });
        expect(graphCalls).toHaveLength(1);
        const [call] = graphCalls;
        expect(call.method).toBe('POST');
        expect(call.url.host).toBe('graph.facebook.com');
        expect(path(call)).toBe(`/${EDGE}`);
        expect(call.body?.get('subscribed_fields')).toBe('feed');
        expect(call.body?.get('access_token')).toBe(pageToken);
        // Not in the URL, where a proxy log would keep it.
        expect(call.url.search).toBe('');
        expect(String(call.url)).not.toContain(pageToken);
        expect(logLines).toEqual([
          `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=done`,
        ]);
        expect(logLines[0]).not.toContain('comment=');
      });

      it('answers 400 actor_missing without a call to the database or Meta', async () => {
        for (const actor of [null, '', '   ']) {
          const res = await subscribe(CHANNEL, { actor });
          expect(res.status).toBe(400);
          expect(res.json()).toMatchObject({ code: 'actor_missing' });
        }
        expect(graphCalls).toEqual([]);
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      });

      it('answers 401 without a token and 404 without the demo list', async () => {
        expect((await subscribe(CHANNEL, { auth: '' })).status).toBe(401);
        expect(
          (await subscribe(CHANNEL, { auth: 'Bearer wrong' })).status
        ).toBe(401);
        delete process.env[LIST_ENV];
        expect((await subscribe()).status).toBe(404);
        expect(graphCalls).toEqual([]);
      });

      it('answers 403 not_demo_integration for a channel that is not listed', async () => {
        const res = await subscribe(OTHER_CHANNEL);
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        expect(graphCalls).toEqual([]);
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(logLines).toEqual([
          `inbox subscribe channel=- actor=${ACTOR} result=rejected code=not_demo_integration`,
        ]);
      });

      it('answers 404 not_found for a listed channel that does not exist', async () => {
        repository.getChannelForInbox.mockResolvedValue(null);
        const res = await subscribe();
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
        expect(graphCalls).toEqual([]);
      });

      it.each([
        ['disabled', { disabled: true }],
        ['refreshNeeded', { refreshNeeded: true }],
        ['inBetweenSteps', { inBetweenSteps: true }],
        ['deleted', { deletedAt: new Date('2026-11-01T00:00:00Z') }],
      ])(
        'answers 409 channel_inactive for a channel that is %s, without a call',
        async (_name, patch) => {
          repository.getChannelForInbox.mockResolvedValue(row(patch));
          const res = await subscribe();
          expect(res.status).toBe(409);
          expect(res.json()).toMatchObject({ code: 'channel_inactive' });
          expect(graphCalls).toEqual([]);
          expect(logLines).toEqual([
            `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=channel_inactive`,
          ]);
        }
      );

      it('answers 409 provider_not_supported for a provider without an inbox', async () => {
        repository.getChannelForInbox.mockResolvedValue(
          row({ providerIdentifier: 'linkedin' })
        );
        const res = await subscribe();
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'provider_not_supported' });
        expect(graphCalls).toEqual([]);
      });

      it.each([
        ['success false', { success: false }],
        ['no success field', {}],
        ['success as text', { success: 'true' }],
      ])(
        'answers 502 platform_error when Meta answers 200 with %s',
        async (_name, answer) => {
          graphHandler = (call) =>
            call.method === 'POST' ? json(answer) : defaultGraph(call);
          const res = await subscribe();
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({
            code: 'platform_error',
            platformStatus: 200,
          });
          expect(res.json()).not.toHaveProperty('subscribed');
          expect(graphCalls).toHaveLength(1);
          expect(logLines).toEqual([
            `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=platform_error status=200 platform=-/-`,
          ]);
        }
      );

      it('answers 502 for a refusal of Meta (4xx) with the codes, one attempt', async () => {
        graphHandler = () =>
          json(
            { error: { message: META_MESSAGE, code: 200, error_subcode: 1 } },
            403
          );
        const res = await subscribe();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 403,
          platformCode: 200,
          platformSubcode: 1,
        });
        expect(graphCalls).toHaveLength(1);
        expect(logLines).toEqual([
          `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=platform_error status=403 platform=200/1`,
        ]);
      });

      it.each([500, 502, 503, 599])(
        'answers 503 outcome_unknown for HTTP %s, with exactly one attempt',
        async (status) => {
          graphHandler = () =>
            json({ error: { message: META_MESSAGE, code: 2 } }, status);
          const res = await subscribe();
          expect(res.status).toBe(503);
          expect(res.json()).toEqual({
            statusCode: 503,
            code: 'outcome_unknown',
          });
          expect(graphCalls).toHaveLength(1);
          expect(logLines).toEqual([
            `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=outcome_unknown status=${status} platform=2/-`,
          ]);
        }
      );

      it('answers 503 outcome_unknown for a network error, with exactly one attempt', async () => {
        graphHandler = () => {
          throw new Error(`fetch failed access_token=${pageToken}`);
        };
        const res = await subscribe();
        expect(res.status).toBe(503);
        expect(res.json()).toEqual({
          statusCode: 503,
          code: 'outcome_unknown',
        });
        expect(graphCalls).toHaveLength(1);
        expect(logLines).toEqual([
          `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=outcome_unknown`,
        ]);
      });

      it('answers 500 internal_error for an unexpected error, with the class name only', async () => {
        repository.getChannelForInbox.mockRejectedValue(
          new TypeError(`broken ${pageToken}`)
        );
        const res = await subscribe();
        expect(res.status).toBe(500);
        expect(res.json()).toMatchObject({ code: 'internal_error' });
        expect(logLines).toEqual([
          `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=internal_error error=TypeError`,
        ]);
        expect(graphCalls).toEqual([]);
      });

      it('needs no body and writes once', async () => {
        const res = await subscribe(CHANNEL, { body: undefined });
        expect(res.status).toBe(200);
        expect(writes()).toHaveLength(1);
        expect(edgeCalls()).toHaveLength(1);
      });
    });

    describe('2xx without a readable body', () => {
      it.each(unreadable)(
        'answers 503 outcome_unknown when subscribing gets %s, with exactly one attempt',
        async (_name, make) => {
          graphHandler = (call) =>
            call.method === 'POST' ? make() : defaultGraph(call);
          const res = await subscribe();
          expect(res.status).toBe(503);
          expect(res.json()).toEqual({
            statusCode: 503,
            code: 'outcome_unknown',
          });
          expect(res.text).not.toContain('subscribed');
          expect(graphCalls).toHaveLength(1);
          expect(logLines).toEqual([
            `inbox subscribe channel=${CHANNEL} actor=${ACTOR} result=rejected code=outcome_unknown status=${
              make().status
            } platform=-/- body=unreadable`,
          ]);
        }
      );

      it.each(unreadable)(
        'answers 502 platform_error when the state of the webhooks gets %s',
        async (_name, make) => {
          graphHandler = (call) =>
            call.method === 'GET' && path(call) === `/${EDGE}`
              ? make()
              : defaultGraph(call);
          const res = await getWebhooks();
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({
            code: 'platform_error',
            platformStatus: make().status,
            reason: 'Die Plattform hat keine lesbare Antwort geschickt.',
          });
          expect(res.json()).not.toHaveProperty('subscribed');
          expect(logLines).toEqual([
            `inbox webhooks channel=${CHANNEL} result=rejected code=platform_error status=${
              make().status
            } platform=-/- body=unreadable`,
          ]);
        }
      );

      it('keeps 502 platform_error for {"success": false} when subscribing', async () => {
        graphHandler = (call) =>
          call.method === 'POST'
            ? json({ success: false })
            : defaultGraph(call);
        const res = await subscribe();
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 200,
        });
        expect(logLines.join('\n')).not.toContain('unreadable');
      });
    });
  });
});
