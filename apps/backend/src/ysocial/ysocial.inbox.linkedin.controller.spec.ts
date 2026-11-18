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
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialModule } from './ysocial.module';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialWebhookRepository } from '../../../../libraries/ysocial/src/database/ysocial.webhook.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialAutomationRepository } from '../../../../libraries/ysocial/src/database/ysocial.automation.repository';
import { YsocialAutomationCheck } from '../../../../libraries/ysocial/src/automation/ysocial.automation.check';

/**
 * The inbox routes of Phase 3 PR 75 through Nest and a real HTTP server with
 * a LinkedIn page, LinkedIn mocked: the switch YSOCIAL_INBOX_LINKEDIN,
 * capabilities, items, one comment, reply, delete, like and unlike, the
 * errors, and a log without token and text.
 */

const TOKEN_ENV = 'YSOCIAL_SERVICE_TOKEN';
const LIST_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
const SWITCH_ENV = 'YSOCIAL_INBOX_ENABLED';
const EVENTS_ENV = 'YSOCIAL_INBOX_EVENTS';
const LINKEDIN_ENV = 'YSOCIAL_INBOX_LINKEDIN';
const serviceToken = randomBytes(32).toString('hex');
// Integration.token of "linkedin-page": the access token of the member.
const accessToken = randomBytes(24).toString('hex');

// Invented data only.
const CHANNEL = 'int-li-1';
const ORG = '100000001';
const ORG_URN = `urn:li:organization:${ORG}`;
const FOREIGN_ORG_URN = 'urn:li:organization:100000999';
const PERSON_URN = 'urn:li:person:erfundenAbc';
const SHARE = '7000000000000000001';
const SHARE_URN = `urn:li:share:${SHARE}`;
const SHARE_POST = `1_${SHARE}`;
const FOREIGN_SHARE = '7000000000000000009';
const ACTIVITY = '8000000000000000001';
const C1 = '9000000000000000001';
const C9 = '9000000000000000009';
const R1 = '9100000000000000001';
const R2 = '9100000000000000002';
const COMMENT = `1_${SHARE}_${C1}`;
const REPLY = `1_${SHARE}_${C1}_${R1}`;
const NEW_REPLY = `1_${SHARE}_${C1}_${R2}`;
const FOREIGN_COMMENT = `1_${FOREIGN_SHARE}_${C1}`;
const MISSING_COMMENT = `1_${SHARE}_${C9}`;
const ACTIVITY_COMMENT = `0_${ACTIVITY}_${C1}`;
const COMMENT_URN = `urn:li:comment:(urn:li:share:${SHARE},${C1})`;
const ACTOR = 'anna@example.com';
const COMMENT_TEXT = 'Erfundener Kommentar';
const REPLY_TEXT = 'Erfundene Antwort des Kontos';
const LINKEDIN_MESSAGE = 'Erfundene Meldung von LinkedIn, nie im Log';
const MENTION_PART = 'Zeppelinwiese';

const row = (patch: Record<string, unknown> = {}): any => ({
  id: CHANNEL,
  providerIdentifier: 'linkedin-page',
  internalId: ORG,
  token: accessToken,
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  deletedAt: null,
  ...patch,
});

const repository = { getChannelForInbox: jest.fn() };

// Stand-ins for what the Global DatabaseModule of Postiz provides.
@Global()
@Module({
  providers: [
    { provide: PostsService, useValue: {} },
    { provide: IntegrationManager, useValue: {} },
    { provide: TemporalService, useValue: {} },
  ],
  exports: [PostsService, IntegrationManager, TemporalService],
})
class InboxTestModule {}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type LinkedinCall = {
  method: string;
  raw: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
};
const linkedinCalls: LinkedinCall[] = [];
let linkedinHandler: (call: LinkedinCall) => Response | Promise<Response>;

const day = (offset: number) => Date.now() - offset * 86_400_000;

const commentRow = (
  id: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  commentUrn: `urn:li:comment:(urn:li:share:${SHARE},${id})`,
  actor: PERSON_URN,
  message: {
    text: `${COMMENT_TEXT} ${MENTION_PART}`,
    attributes: [
      {
        start: COMMENT_TEXT.length + 1,
        length: MENTION_PART.length,
        value: { person: 'urn:li:person:erwaehnt' },
      },
    ],
  },
  created: { time: day(1) },
  likesSummary: { totalLikes: 2 },
  ...over,
});
const replyRow = (id: string) =>
  commentRow(id, {
    parentComment: COMMENT_URN,
    actor: ORG_URN,
    message: { text: REPLY_TEXT },
    created: { time: day(0.5) },
  });

const notFound = () => json({ status: 404, message: 'Not found' }, 404);

// The platform: one own post of yesterday with a comment (C1) that has a
// reply (R1); the post FOREIGN_SHARE belongs to another organization.
const defaultLinkedin = ({ method, path, query }: LinkedinCall): Response => {
  const key = `${method} ${path}`;
  switch (key) {
    case 'GET posts':
      return json({
        elements:
          query.get('start') === '0'
            ? [
                {
                  id: SHARE_URN,
                  author: ORG_URN,
                  lifecycleState: 'PUBLISHED',
                  createdAt: day(1),
                },
              ]
            : [],
      });
    case `GET posts/${SHARE_URN}`:
      return json({
        id: SHARE_URN,
        author: ORG_URN,
        lifecycleState: 'PUBLISHED',
        createdAt: day(1),
      });
    case `GET posts/urn:li:share:${FOREIGN_SHARE}`:
      return json({
        id: `urn:li:share:${FOREIGN_SHARE}`,
        author: FOREIGN_ORG_URN,
        lifecycleState: 'PUBLISHED',
        createdAt: day(1),
      });
    case `GET socialActions/${SHARE_URN}/comments`:
      return json({
        elements: [
          commentRow(C1, { commentsSummary: { totalFirstLevelComments: 1 } }),
        ],
      });
    case `GET socialActions/${COMMENT_URN}/comments`:
      return json({ elements: [replyRow(R1)] });
    case `GET socialActions/${SHARE_URN}/comments/${C1}`:
      return json(commentRow(C1));
    case `GET socialActions/${COMMENT_URN}/comments/${R1}`:
      return json(replyRow(R1));
    case `POST socialActions/${COMMENT_URN}/comments`:
      return json(null, 201, { 'x-restli-id': R2 });
    case `DELETE socialActions/${SHARE_URN}/comments/${C1}`:
    case `DELETE socialActions/${SHARE_URN}/comments/${R1}`:
      return json(null, 204);
    case 'POST reactions':
      return json(null, 201);
    case `DELETE reactions/(actor:${ORG_URN},entity:${COMMENT_URN})`:
      return json(null, 204);
    default:
      return notFound();
  }
};

describe('/ysocial/inbox with a LinkedIn page', () => {
  const ENVS = [TOKEN_ENV, LIST_ENV, SWITCH_ENV, EVENTS_ENV, LINKEDIN_ENV];
  const savedEnv = ENVS.map((name) => process.env[name]);
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
    ENVS.forEach((name, i) => {
      if (savedEnv[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[i];
      }
    });
  });

  beforeEach(() => {
    process.env[TOKEN_ENV] = serviceToken;
    // The default of these tests: the switches on, no demo list.
    process.env[SWITCH_ENV] = 'true';
    process.env[LINKEDIN_ENV] = 'true';
    delete process.env[LIST_ENV];
    delete process.env[EVENTS_ENV];
    jest.clearAllMocks();
    linkedinCalls.length = 0;
    responses = [];
    linkedinHandler = defaultLinkedin;
    repository.getChannelForInbox.mockResolvedValue(row());

    // Only calls to LinkedIn are caught, the test itself calls the server
    // with fetch.
    global.fetch = (async (input: any, init: any = {}) => {
      const raw = String(input);
      if (!raw.startsWith('https://api.linkedin.com/')) {
        return realFetch(input, init);
      }
      const url = new URL(raw);
      const call: LinkedinCall = {
        method: init.method || 'GET',
        raw,
        path: decodeURIComponent(url.pathname).replace(/^\/rest\//, ''),
        query: url.searchParams,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      linkedinCalls.push(call);
      return linkedinHandler(call);
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

    // Privacy, in every case, errors included: no comment text, reply text,
    // tagged part, token or message of the platform in a log line, no token
    // in an answer.
    const log = logLines.join('\n');
    for (const secret of [
      COMMENT_TEXT,
      REPLY_TEXT,
      LINKEDIN_MESSAGE,
      MENTION_PART,
      accessToken,
      serviceToken,
    ]) {
      expect(log).not.toContain(secret);
    }
    for (const text of responses) {
      for (const secret of [accessToken, serviceToken]) {
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
    }: { auth?: string; actor?: string | null; body?: unknown } = {}
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

  const capabilities = (id = CHANNEL) =>
    request('GET', `/integrations/${id}/capabilities`);
  const items = (id = CHANNEL, query = '') =>
    request('GET', `/integrations/${id}/items${query}`);
  const comments = (id = CHANNEL) =>
    request('GET', `/integrations/${id}/comments`);
  const comment = (commentId = COMMENT, query = '', id = CHANNEL) =>
    request('GET', `/integrations/${id}/comments/${commentId}${query}`);
  const reply = (
    commentId = COMMENT,
    query = '',
    opts: Parameters<typeof request>[2] = { body: { message: REPLY_TEXT } }
  ) =>
    request(
      'POST',
      `/integrations/${CHANNEL}/comments/${commentId}/replies${query}`,
      opts
    );
  const hide = (commentId = COMMENT) =>
    request('POST', `/integrations/${CHANNEL}/comments/${commentId}/hide`, {
      body: { hide: true },
    });
  const remove = (
    commentId = COMMENT,
    query = '',
    opts: Parameters<typeof request>[2] = { body: { confirmDelete: true } }
  ) =>
    request(
      'DELETE',
      `/integrations/${CHANNEL}/comments/${commentId}${query}`,
      opts
    );
  const like = (commentId = COMMENT, query = '') =>
    request(
      'POST',
      `/integrations/${CHANNEL}/comments/${commentId}/like${query}`
    );
  const unlike = (commentId = COMMENT, query = '') =>
    request(
      'DELETE',
      `/integrations/${CHANNEL}/comments/${commentId}/like${query}`
    );

  const writes = () => linkedinCalls.filter((call) => call.method !== 'GET');

  describe('the switch YSOCIAL_INBOX_LINKEDIN', () => {
    const routes = [
      ['capabilities', () => capabilities()],
      ['items', () => items()],
      ['comments', () => comments()],
      ['one comment', () => comment()],
      ['reply', () => reply()],
      ['hide', () => hide()],
      ['delete', () => remove()],
      ['like', () => like()],
      ['unlike', () => unlike()],
      ['webhooks', () => request('GET', `/integrations/${CHANNEL}/webhooks`)],
      ['subscribe', () => request('POST', `/integrations/${CHANNEL}/webhooks`)],
    ] as const;

    describe.each([
      ['no variable', undefined],
      ['"false"', 'false'],
      ['"TRUE"', 'TRUE'],
      ['"1"', '1'],
      ['an empty value', ''],
    ])('with %s', (_name, value) => {
      beforeEach(() => {
        if (value === undefined) {
          delete process.env[LINKEDIN_ENV];
        } else {
          process.env[LINKEDIN_ENV] = value;
        }
        // Every other switch is on: they must not open the inbox.
        process.env[SWITCH_ENV] = 'true';
        process.env[EVENTS_ENV] = 'true';
        process.env[LIST_ENV] = CHANNEL;
      });

      it.each(routes)(
        'answers 409 provider_not_supported on %s, with no call to LinkedIn',
        async (_route, run) => {
          const res = await run();
          expect(res.status).toBe(409);
          expect(res.json()).toMatchObject({
            code: 'provider_not_supported',
            provider: 'linkedin-page',
          });
          expect(linkedinCalls).toEqual([]);
        }
      );
    });

    it('lets the listed channel through with the demo list alone, when YSOCIAL_INBOX_LINKEDIN is true', async () => {
      process.env[LIST_ENV] = CHANNEL;
      delete process.env[SWITCH_ENV];
      expect((await capabilities()).status).toBe(200);
      expect((await items()).status).toBe(200);
      expect(linkedinCalls.length).toBeGreaterThan(0);
    });

    it('answers 409 for a LinkedIn channel on the demo list too, without YSOCIAL_INBOX_ENABLED', async () => {
      process.env[LIST_ENV] = CHANNEL;
      delete process.env[SWITCH_ENV];
      delete process.env[LINKEDIN_ENV];
      expect((await capabilities()).status).toBe(409);
      expect(linkedinCalls).toEqual([]);
    });

    it('does not touch Facebook and Instagram channels', async () => {
      delete process.env[LINKEDIN_ENV];
      repository.getChannelForInbox.mockResolvedValue(
        row({ providerIdentifier: 'facebook' })
      );
      const res = await capabilities();
      expect(res.status).toBe(200);
      expect(res.json().provider).toBe('facebook');
      expect(linkedinCalls).toEqual([]);
    });
  });

  describe('capabilities', () => {
    it('answers what LinkedIn allows, without a call to LinkedIn', async () => {
      const res = await capabilities();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        provider: 'linkedin-page',
        capabilities: {
          reply: true,
          hide: false,
          delete: true,
          like: true,
          realtime: false,
        },
      });
      expect(linkedinCalls).toEqual([]);
      expect(logLines).toEqual([
        `inbox capabilities channel=${CHANNEL} result=ok`,
      ]);
    });
  });

  describe('hide', () => {
    it('answers 409 action_not_supported and does not call LinkedIn', async () => {
      const res = await hide();
      expect(res.status).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'action_not_supported',
        provider: 'linkedin-page',
      });
      expect(linkedinCalls).toEqual([]);
      expect(logLines).toEqual([
        `inbox hide channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=rejected code=action_not_supported`,
      ]);
    });

    it('answers the same for unhide', async () => {
      const res = await request(
        'POST',
        `/integrations/${CHANNEL}/comments/${COMMENT}/hide`,
        { body: { hide: false } }
      );
      expect(res.status).toBe(409);
      expect(res.json()).toMatchObject({ code: 'action_not_supported' });
      expect(linkedinCalls).toEqual([]);
    });
  });

  describe('items', () => {
    it('answers the post, the comment and the reply as the hub needs them', async () => {
      const res = await items();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        integrationId: CHANNEL,
        provider: 'linkedin-page',
        nextCursor: null,
        usage: null,
      });
      expect(body.posts).toEqual([
        {
          id: SHARE_POST,
          permalink: `https://www.linkedin.com/feed/update/${SHARE_URN}/`,
          timestamp: expect.any(String),
          mediaType: null,
          commentsCount: null,
          truncated: false,
        },
      ]);
      expect(body.items).toEqual([
        {
          id: COMMENT,
          postId: SHARE_POST,
          parentId: null,
          text: `${COMMENT_TEXT} ${MENTION_PART}`,
          username: null,
          timestamp: expect.any(String),
          likeCount: 2,
          hidden: false,
          fromOwner: false,
          mentions: [MENTION_PART],
        },
        {
          id: REPLY,
          postId: SHARE_POST,
          parentId: COMMENT,
          text: REPLY_TEXT,
          username: null,
          timestamp: expect.any(String),
          likeCount: 2,
          hidden: false,
          fromOwner: true,
          mentions: [],
        },
      ]);
      // No URN of a person, no token.
      expect(JSON.stringify(body.items)).not.toContain('urn:li');
      expect(res.text).not.toContain(PERSON_URN);
      expect(logLines).toEqual([
        `inbox items channel=${CHANNEL} result=ok posts=1 items=2 next=no`,
      ]);
    });

    it('asks LinkedIn with the finder, the header and the version', async () => {
      await items();
      expect(linkedinCalls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
      const [finder, ...rest] = linkedinCalls;
      expect(finder.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
        'X-RestLi-Method': 'FINDER',
      });
      expect(Object.fromEntries(finder.query)).toEqual({
        q: 'author',
        author: ORG_URN,
        sortBy: 'CREATED',
        count: '5',
        start: '0',
      });
      for (const call of rest) {
        expect(call.headers).not.toHaveProperty('X-RestLi-Method');
      }
    });

    it('passes the cursor on as the start of the finder', async () => {
      await items(CHANNEL, '?cursor=5');
      expect(linkedinCalls[0].query.get('start')).toBe('5');
    });

    it('filters with since', async () => {
      const since = encodeURIComponent(new Date(day(0.75)).toISOString());
      const res = await items(CHANNEL, `?since=${since}`);
      expect(res.status).toBe(200);
      expect(res.json().items.map((item: any) => item.id)).toEqual([REPLY]);
    });

    it('answers 502 platform_error with platformStatus 403 when the role ADMINISTRATOR is missing', async () => {
      linkedinHandler = () =>
        json(
          {
            status: 403,
            serviceErrorCode: 100,
            message: `Not enough permissions ${LINKEDIN_MESSAGE}`,
          },
          403
        );
      const res = await items();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 403,
        platformCode: 100,
      });
      expect(logLines).toEqual([
        `inbox items channel=${CHANNEL} result=rejected code=platform_error status=403 platform=100/-`,
      ]);
    });

    it('answers 503 platform_unavailable when LinkedIn cannot be reached', async () => {
      linkedinHandler = () => {
        throw new TypeError('fetch failed');
      };
      const res = await items();
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'platform_unavailable' });
    });
  });

  describe('the demo list of comments', () => {
    it('answers the posts with comments and replies', async () => {
      const res = await comments();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.provider).toBe('linkedin-page');
      expect(body.posts[0]).toMatchObject({ id: SHARE_POST, commentsCount: 1 });
      expect(body.posts[0].comments[0].replies.map((r: any) => r.id)).toEqual([
        REPLY,
      ]);
    });
  });

  describe('one comment', () => {
    it('answers the conversation of a comment and checks the post first', async () => {
      const res = await comment();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        integrationId: CHANNEL,
        provider: 'linkedin-page',
        commentId: COMMENT,
        post: { id: SHARE_POST },
      });
      expect(body.items.map((item: any) => item.id)).toEqual([COMMENT, REPLY]);
      expect(linkedinCalls[0].path).toBe(`posts/${SHARE_URN}`);
      expect(logLines).toEqual([
        `inbox comment channel=${CHANNEL} comment=${COMMENT} result=ok items=2`,
      ]);
    });

    it('answers the conversation of a reply', async () => {
      const res = await comment(REPLY);
      expect(res.status).toBe(200);
      expect(res.json().items.map((item: any) => item.id)).toEqual([
        COMMENT,
        REPLY,
      ]);
    });

    it.each([
      ['a post of another author', FOREIGN_COMMENT],
      ['a comment that is not under the post', MISSING_COMMENT],
    ])('answers 404 comment_not_found for %s', async (_name, commentId) => {
      const res = await comment(commentId);
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ code: 'comment_not_found' });
    });

    it('answers 503 ownership_unknown when a postId contradicts the thread, with no call', async () => {
      const res = await comment(COMMENT, `?postId=1_${FOREIGN_SHARE}`);
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'ownership_unknown' });
      expect(linkedinCalls).toEqual([]);
    });

    it('answers 503 ownership_unknown for an activity comment without postId, with no call', async () => {
      const res = await comment(ACTIVITY_COMMENT);
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'ownership_unknown' });
      expect(linkedinCalls).toEqual([]);
    });

    it('answers 502 platform_error, not 404, when LinkedIn sends a post without author', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.path === `posts/${SHARE_URN}`
          ? json({ id: SHARE_URN })
          : original(call);
      const res = await comment();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ code: 'platform_error' });
    });

    it('costs 4 calls for a reply and 3 for a top-level comment', async () => {
      await comment(REPLY);
      expect(linkedinCalls).toHaveLength(4);
      linkedinCalls.length = 0;
      await comment(COMMENT);
      expect(linkedinCalls).toHaveLength(3);
    });

    it('answers 400 invalid_comment_id for an id with other characters', async () => {
      const res = await comment('1_abc');
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_comment_id' });
      expect(linkedinCalls).toEqual([]);
    });

    it('answers 400 for a postId with other characters', async () => {
      const res = await comment(COMMENT, '?postId=urn:li:share:1');
      expect(res.status).toBe(400);
      expect(linkedinCalls).toEqual([]);
    });
  });

  describe('reply', () => {
    it('posts one comment as the organization under the top-level comment and answers the new id', async () => {
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        replyId: NEW_REPLY,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('POST');
      expect(write.raw).toBe(
        `https://api.linkedin.com/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29/comments`
      );
      expect(write.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      });
      expect(write.body).toEqual({
        actor: ORG_URN,
        object: SHARE_URN,
        message: { text: REPLY_TEXT },
        parentComment: COMMENT_URN,
      });
      expect(logLines).toEqual([
        `inbox reply channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('answers a reply to a reply under the top-level comment', async () => {
      const res = await reply(REPLY);
      expect(res.status).toBe(201);
      expect(writes()[0].body.parentComment).toBe(COMMENT_URN);
      expect(res.json().replyId).toBe(NEW_REPLY);
    });

    it('answers replyId null when LinkedIn sends no id', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST' ? json(null, 201) : original(call);
      const res = await reply();
      expect(res.status).toBe(201);
      expect(res.json().replyId).toBeNull();
    });

    it('answers 400 without the actor or with a blank text and writes nothing', async () => {
      expect(
        (
          await reply(COMMENT, '', {
            body: { message: REPLY_TEXT },
            actor: null,
          })
        ).status
      ).toBe(400);
      expect(
        (await reply(COMMENT, '', { body: { message: '  ' } })).status
      ).toBe(400);
      expect(linkedinCalls).toEqual([]);
    });

    it.each([
      ['a post of another author', FOREIGN_COMMENT],
      ['a comment that is not under the post', MISSING_COMMENT],
    ])(
      'answers 404 comment_not_found for %s and writes nothing',
      async (_n, id) => {
        const res = await reply(id);
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
        expect(writes()).toEqual([]);
      }
    );

    it('answers 503 ownership_unknown for an activity comment without postId and calls nothing', async () => {
      const res = await reply(ACTIVITY_COMMENT);
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'ownership_unknown' });
      expect(linkedinCalls).toEqual([]);
    });

    it('answers an activity comment with the postId of the post', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST'
          ? json(null, 201, { 'x-restli-id': R2 })
          : call.path === `socialActions/${SHARE_URN}/comments/${C1}`
          ? json(
              commentRow(C1, {
                commentUrn: `urn:li:comment:(urn:li:activity:${ACTIVITY},${C1})`,
              })
            )
          : original(call);
      const res = await reply(ACTIVITY_COMMENT, `?postId=${SHARE_POST}`);
      expect(res.status).toBe(201);
      expect(res.json().replyId).toBe(`0_${ACTIVITY}_${C1}_${R2}`);
      expect(writes()[0].body).toMatchObject({
        object: SHARE_URN,
        parentComment: `urn:li:comment:(urn:li:activity:${ACTIVITY},${C1})`,
      });
    });

    it('answers 502 platform_error with platformStatus 403 when the role ADMINISTRATOR is missing', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST'
          ? json(
              {
                status: 403,
                serviceErrorCode: 100,
                message: LINKEDIN_MESSAGE,
              },
              403
            )
          : original(call);
      const res = await reply();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 403,
      });
      expect(writes()).toHaveLength(1);
    });

    it('answers 503 outcome_unknown for a 5xx of the write, and for a network error', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST' ? json({}, 500) : original(call);
      let res = await reply();
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'outcome_unknown' });

      linkedinHandler = (call) => {
        if (call.method === 'POST') {
          throw new TypeError('fetch failed');
        }
        return original(call);
      };
      res = await reply();
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'outcome_unknown' });
    });
  });

  describe('delete', () => {
    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['confirmDelete false', { confirmDelete: false }],
    ])(
      'answers 409 confirmation_required with %s and calls nothing',
      async (_n, body) => {
        const res = await remove(COMMENT, '', { body });
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'confirmation_required' });
        expect(linkedinCalls).toEqual([]);
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      }
    );

    it('sends one DELETE as the organization with confirmDelete true', async () => {
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
      expect(write.raw).toBe(
        `https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments/${C1}?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
      expect(write.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
      });
      expect(write.body).toBeUndefined();
      expect(logLines).toEqual([
        `inbox delete channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('deletes a reply under the post, like a top-level comment', async () => {
      const res = await remove(REPLY);
      expect(res.status).toBe(200);
      expect(writes()[0].raw).toBe(
        `https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments/${R1}?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
    });

    it('answers 404 comment_not_found for a comment of another author and deletes nothing', async () => {
      const res = await remove(FOREIGN_COMMENT);
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      expect(writes()).toEqual([]);
    });

    it('answers 502 with platformStatus 403 when the role is missing', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'DELETE' ? json({ message: 'x' }, 403) : original(call);
      const res = await remove();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 403,
      });
    });

    it('answers 503 outcome_unknown for a 5xx', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'DELETE' ? json({}, 503) : original(call);
      const res = await remove();
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ code: 'outcome_unknown' });
    });
  });

  describe('like', () => {
    it('likes with one POST to /reactions and answers liked true', async () => {
      const res = await like();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        commentId: COMMENT,
        liked: true,
      });
      expect(writes()).toHaveLength(1);
      const [write] = writes();
      expect(write.method).toBe('POST');
      expect(write.raw).toBe(
        `https://api.linkedin.com/rest/reactions?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
      expect(write.body).toEqual({ root: COMMENT_URN, reactionType: 'LIKE' });
      expect(logLines).toEqual([
        `inbox like channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('takes the like back with one DELETE and answers liked false', async () => {
      const res = await unlike();
      expect(res.status).toBe(200);
      expect(res.json()).toMatchObject({ liked: false });
      expect(writes()).toHaveLength(1);
      expect(writes()[0].method).toBe('DELETE');
      expect(writes()[0].raw).toBe(
        `https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aorganization%3A${ORG},entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29)`
      );
      expect(logLines).toEqual([
        `inbox unlike channel=${CHANNEL} comment=${COMMENT} actor=${ACTOR} result=done`,
      ]);
    });

    it('counts a like that is there (409) and an unlike of none (404) as done', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST' && call.path === 'reactions'
          ? json({ message: 'duplicate' }, 409)
          : call.method === 'DELETE' && call.path.startsWith('reactions/')
          ? notFound()
          : original(call);
      expect((await like()).status).toBe(200);
      expect((await unlike()).status).toBe(200);
    });

    it('answers 502 for the other errors', async () => {
      const original = linkedinHandler;
      linkedinHandler = (call) =>
        call.method === 'POST' && call.path === 'reactions'
          ? json({ message: 'x' }, 403)
          : original(call);
      const res = await like();
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'platform_error',
        platformStatus: 403,
      });
    });

    it('answers 404 comment_not_found for a comment of another author', async () => {
      for (const res of [
        await like(FOREIGN_COMMENT),
        await unlike(FOREIGN_COMMENT),
      ]) {
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
      }
      expect(writes()).toEqual([]);
    });
  });

  describe('webhook routes', () => {
    beforeEach(() => {
      process.env[EVENTS_ENV] = 'true';
    });

    it('answers subscribed false and calls nothing', async () => {
      const res = await request('GET', `/integrations/${CHANNEL}/webhooks`);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        integrationId: CHANNEL,
        provider: 'linkedin-page',
        subscribed: false,
        fields: [],
      });
      expect(linkedinCalls).toEqual([]);
    });

    it('answers 502 to subscribing and calls nothing', async () => {
      const res = await request('POST', `/integrations/${CHANNEL}/webhooks`);
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ code: 'platform_error' });
      expect(linkedinCalls).toEqual([]);
    });
  });
});
