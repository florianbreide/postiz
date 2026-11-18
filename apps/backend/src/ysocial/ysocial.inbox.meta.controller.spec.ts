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
import { YsocialInboxService } from '../../../../libraries/ysocial/src/inbox/ysocial.inbox.service';
import { FacebookInbox } from '../../../../libraries/ysocial/src/inbox/facebook.inbox';
import { InstagramInbox } from '../../../../libraries/ysocial/src/inbox/instagram.inbox';

/**
 * The inbox routes of Phase 3 PR 73 through Nest and a real HTTP server,
 * with the Graph API mocked: capabilities, items (window, since, cursor,
 * usage), one comment, like, the switch YSOCIAL_INBOX_ENABLED and the query
 * validation. Facebook and Instagram run the same cases.
 */

const TOKEN_ENV = 'YSOCIAL_SERVICE_TOKEN';
const LIST_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
const SWITCH_ENV = 'YSOCIAL_INBOX_ENABLED';
// Phase 3, PR 74: the webhook routes for every channel.
const EVENTS_ENV = 'YSOCIAL_INBOX_EVENTS';
const APP_ID_ENV = 'FACEBOOK_APP_ID';
const APP_ID = '900000000000001';
const serviceToken = randomBytes(32).toString('hex');
const pageToken = randomBytes(24).toString('hex');
const userToken = randomBytes(24).toString('hex');

// Invented data only.
const DEMO = 'int-demo-fb-1';
const FB_CHANNEL = 'int-other-fb-1';
const IG_CHANNEL = 'int-other-ig-1';
const PAGE = '100000000000001';
const IG = '17840000000000001';
const FB_POST = `${PAGE}_200000000000001`;
const FB_COMMENT = '200000000000001_300000000000001';
const FB_REPLY = '300000000000001_400000000000001';
const FB_FOREIGN = '200000000000009_300000000000009';
const IG_MEDIA = '17900000000000001';
const IG_COMMENT = '17950000000000001';
const IG_REPLY = '17950000000000003';
const IG_FOREIGN = '17950000000000009';
const IG_FOREIGN_MEDIA = '17900000000000009';
const ACTOR = 'anna@example.com';
const COMMENT_TEXT = 'Erfundener Kommentar';
const COMMENTER = 'erfundene_person';
const REPLY_TEXT = 'Erfundene Antwort';
const META_MESSAGE = 'Erfundene Meldung von Meta, nie im Log';
// Names tagged in a comment (W76): never in a log line.
const MENTION_PERSON = 'Erika Beispiel';
const MENTION_PAGE = 'Beispiel Werkstatt';
// A part of a text that a tag covers, unique so a log line cannot hold it by
// chance.
const MENTION_PART = 'Zeppelinwiese';
const MENTION_PART_TEXT = `Danke ${MENTION_PART}, super!`;

const rows: Record<string, any> = {
  [DEMO]: {
    id: DEMO,
    providerIdentifier: 'facebook',
    internalId: PAGE,
    token: pageToken,
  },
  [FB_CHANNEL]: {
    id: FB_CHANNEL,
    providerIdentifier: 'facebook',
    internalId: PAGE,
    token: pageToken,
  },
  [IG_CHANNEL]: {
    id: IG_CHANNEL,
    providerIdentifier: 'instagram',
    internalId: IG,
    token: `${pageToken}___${userToken}`,
  },
};
const row = (id: string) => ({
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  deletedAt: null,
  ...rows[id],
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

// Wall clock of the providers, so a test can use up the budget of 25 s.
let wallClock = Date.now();
class TestFacebookInbox extends FacebookInbox {
  protected clock = () => wallClock;
}
class TestInstagramInbox extends InstagramInbox {
  protected clock = () => wallClock;
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString();

type GraphCall = { method: string; url: URL; body: URLSearchParams | null };
const graphCalls: GraphCall[] = [];
let graphHandler: (call: GraphCall) => Response | Promise<Response>;
const pathOf = (call: GraphCall) =>
  call.url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');

const fbComment = (id: string, created: string, replies: unknown[] = []) => ({
  id,
  message: COMMENT_TEXT,
  from: { name: COMMENTER, id: '500000000000777' },
  created_time: created,
  like_count: 2,
  is_hidden: false,
  comments: { data: replies },
});
const igComment = (id: string, created: string, replies: unknown[] = []) => ({
  id,
  text: COMMENT_TEXT,
  username: COMMENTER,
  timestamp: created,
  like_count: 2,
  hidden: false,
  replies: { data: replies },
});

// Facebook: one post of yesterday with a comment and a reply.
const facebookGraph = ({ method, url }: GraphCall): Response => {
  const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
  if (method === 'GET' && path === `/${PAGE}/published_posts`) {
    return json({
      data: [
        {
          id: FB_POST,
          permalink_url: 'https://www.facebook.com/erfunden/posts/1',
          created_time: day(1),
          status_type: 'added_photos',
          comments: {
            data: [
              fbComment(FB_COMMENT, day(1), [
                {
                  id: FB_REPLY,
                  message: REPLY_TEXT,
                  from: { name: 'Erfundene Seite', id: PAGE },
                  created_time: day(0.5),
                },
              ]),
            ],
          },
        },
      ],
    });
  }
  // The check with postId: the post, the stream of its comments, the thread.
  if (method === 'GET' && path === `/${FB_POST}`) {
    return json({ id: FB_POST, created_time: day(1), from: { id: PAGE } });
  }
  if (method === 'GET' && path === `/${FB_POST}/comments`) {
    return json({
      data: [{ id: FB_COMMENT }, { id: FB_REPLY, parent: { id: FB_COMMENT } }],
    });
  }
  if (method === 'GET' && path === `/${FB_COMMENT}`) {
    return json(
      fbComment(FB_COMMENT, day(1), [
        {
          id: FB_REPLY,
          message: REPLY_TEXT,
          from: { name: 'Erfundene Seite', id: PAGE },
          created_time: day(0.5),
        },
      ])
    );
  }
  if (method === 'POST' && path === `/${FB_COMMENT}/comments`) {
    return json({ id: '300000000000001_400000000000002' });
  }
  if ((method === 'POST' || method === 'DELETE') && path === `/${FB_COMMENT}`) {
    return json({ success: true });
  }
  if (
    method === 'POST' &&
    (path === `/${FB_COMMENT}/likes` || path === `/${FB_REPLY}/likes`)
  ) {
    return json({ success: true });
  }
  if (
    method === 'DELETE' &&
    (path === `/${FB_COMMENT}/likes` || path === `/${FB_REPLY}/likes`)
  ) {
    return json({ success: true });
  }
  return json({ error: { message: 'unexpected call', code: 1 } }, 400);
};

// Instagram: one media of yesterday with a comment and a reply, and a
// comment on a media of another account.
const instagramGraph = ({ method, url }: GraphCall): Response => {
  const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
  const fields = url.searchParams.get('fields');
  if (method === 'POST' && path === `/${IG_COMMENT}/replies`) {
    return json({ id: '17950000000000010' });
  }
  if ((method === 'POST' || method === 'DELETE') && path === `/${IG_COMMENT}`) {
    return json({ success: true });
  }
  if (method !== 'GET') {
    return json({ error: { message: 'unexpected call', code: 1 } }, 400);
  }
  if (path === `/${IG}/media`) {
    return json({
      data: [
        {
          id: IG_MEDIA,
          permalink: 'https://www.instagram.com/p/ERFUNDEN/',
          timestamp: day(1),
          media_type: 'IMAGE',
          comments_count: 2,
        },
      ],
    });
  }
  if (path === `/${IG_MEDIA}/comments`) {
    return json({
      data: [
        igComment(IG_COMMENT, day(1), [
          {
            id: IG_REPLY,
            text: REPLY_TEXT,
            user: { id: IG },
            timestamp: day(0.5),
          },
        ]),
      ],
    });
  }
  if (path === `/${IG_COMMENT}`) {
    // The ownership read asks for the media, the thread read for the replies.
    return fields?.includes('replies')
      ? json(
          igComment(IG_COMMENT, day(1), [
            {
              id: IG_REPLY,
              text: REPLY_TEXT,
              user: { id: IG },
              timestamp: day(0.5),
            },
          ])
        )
      : json({ id: IG_COMMENT, media: { id: IG_MEDIA } });
  }
  if (path === `/${IG_REPLY}`) {
    return json({ id: IG_REPLY, parent_id: IG_COMMENT });
  }
  if (path === `/${IG_FOREIGN}`) {
    return json({ id: IG_FOREIGN, media: { id: IG_FOREIGN_MEDIA } });
  }
  if (path === `/${IG_MEDIA}`) {
    return json({
      id: IG_MEDIA,
      permalink: 'https://www.instagram.com/p/ERFUNDEN/',
      timestamp: day(1),
      media_type: 'IMAGE',
      comments_count: 2,
      owner: { id: IG },
    });
  }
  if (path === `/${IG_FOREIGN_MEDIA}`) {
    return json({ id: IG_FOREIGN_MEDIA, owner: { id: '17840000000000999' } });
  }
  return json({ error: { message: 'unexpected call', code: 1 } }, 400);
};

const platforms = [
  {
    name: 'facebook',
    channel: FB_CHANNEL,
    graph: facebookGraph,
    comment: FB_COMMENT,
    reply: FB_REPLY,
    foreign: FB_FOREIGN,
    post: FB_POST,
    like: true,
    // The Graph path of the list of posts.
    list: `/${PAGE}/published_posts`,
  },
  {
    name: 'instagram',
    channel: IG_CHANNEL,
    graph: instagramGraph,
    comment: IG_COMMENT,
    reply: IG_REPLY,
    foreign: IG_FOREIGN,
    post: IG_MEDIA,
    like: false,
    list: `/${IG}/media`,
  },
] as const;

describe('/ysocial/inbox for Facebook and Instagram (PR 73)', () => {
  const ENVS = [TOKEN_ENV, LIST_ENV, SWITCH_ENV, EVENTS_ENV, APP_ID_ENV];
  const savedEnv = ENVS.map((name) => process.env[name]);
  const realFetch = global.fetch;
  let app: INestApplication;
  let baseUrl: string;
  let logs: jest.SpyInstance[];
  let logLines: string[];
  let responses: string[];
  let savedProviders: unknown;

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

    const service = app.get(YsocialInboxService) as any;
    savedProviders = service.providers;
    service.providers = {
      facebook: new TestFacebookInbox(),
      instagram: new TestInstagramInbox(),
    };
  });

  afterAll(async () => {
    (app.get(YsocialInboxService) as any).providers = savedProviders;
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
    // The default of these tests: the switch on, no demo list.
    process.env[SWITCH_ENV] = 'true';
    delete process.env[LIST_ENV];
    // The PR 73 tests run without the switch of PR 74.
    delete process.env[EVENTS_ENV];
    process.env[APP_ID_ENV] = APP_ID;
    jest.clearAllMocks();
    graphCalls.length = 0;
    responses = [];
    wallClock = Date.now();
    repository.getChannelForInbox.mockImplementation(async (id: string) =>
      rows[id] ? row(id) : null
    );

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

    // Privacy, in every case: no comment text, name, token or message of
    // the platform in a log line, no token in an answer.
    const log = logLines.join('\n');
    for (const secret of [
      COMMENT_TEXT,
      COMMENTER,
      REPLY_TEXT,
      META_MESSAGE,
      MENTION_PERSON,
      MENTION_PAGE,
      MENTION_PART,
      pageToken,
      userToken,
      serviceToken,
    ]) {
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

  const capabilities = (id: string) =>
    request('GET', `/integrations/${id}/capabilities`);
  const items = (id: string, query = '') =>
    request('GET', `/integrations/${id}/items${query}`);
  const comment = (id: string, commentId: string) =>
    request('GET', `/integrations/${id}/comments/${commentId}`);
  const like = (id: string, commentId: string, opts?: any) =>
    request('POST', `/integrations/${id}/comments/${commentId}/like`, opts);
  const unlike = (id: string, commentId: string, opts?: any) =>
    request('DELETE', `/integrations/${id}/comments/${commentId}/like`, opts);

  const writes = () => graphCalls.filter((call) => call.method !== 'GET');

  describe('the switch YSOCIAL_INBOX_ENABLED and the demo list (QA 3)', () => {
    beforeEach(() => {
      graphHandler = facebookGraph;
    });

    const nothingHappened = () => {
      expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      expect(graphCalls).toEqual([]);
    };

    const routes = [
      ['capabilities', () => capabilities(FB_CHANNEL)],
      ['items', () => items(FB_CHANNEL)],
      ['one comment', () => comment(FB_CHANNEL, FB_COMMENT)],
      ['like', () => like(FB_CHANNEL, FB_COMMENT)],
      ['unlike', () => unlike(FB_CHANNEL, FB_COMMENT)],
      [
        'comments',
        () => request('GET', `/integrations/${FB_CHANNEL}/comments`),
      ],
    ] as const;

    describe.each([
      ['no switch and no demo list', undefined, undefined],
      ['the switch "false"', 'false', undefined],
      ['the switch "TRUE"', 'TRUE', undefined],
      ['the switch "1"', '1', undefined],
      ['the switch "" and an empty list', '', ' , '],
    ])('with %s', (_name, switchValue, list) => {
      beforeEach(() => {
        if (switchValue === undefined) {
          delete process.env[SWITCH_ENV];
        } else {
          process.env[SWITCH_ENV] = switchValue;
        }
        if (list === undefined) {
          delete process.env[LIST_ENV];
        } else {
          process.env[LIST_ENV] = list;
        }
      });

      it.each(routes)(
        'answers 404 on %s, before the token and the database',
        async (_route, run) => {
          const res = await run();
          expect(res.status).toBe(404);
          nothingHappened();
        }
      );

      it('answers 404 without a token as well (the guard runs first)', async () => {
        expect((await capabilities(FB_CHANNEL)).status).toBe(404);
        expect(
          (
            await request('GET', `/integrations/${FB_CHANNEL}/items`, {
              auth: '',
            })
          ).status
        ).toBe(404);
        nothingHappened();
      });

      it('answers 404 on the webhook routes', async () => {
        expect(
          (await request('GET', `/integrations/${FB_CHANNEL}/webhooks`)).status
        ).toBe(404);
        expect(
          (await request('POST', `/integrations/${FB_CHANNEL}/webhooks`)).status
        ).toBe(404);
        expect((await request('GET', '/webhooks/events')).status).toBe(404);
        nothingHappened();
      });
    });

    describe('with a demo list and no switch', () => {
      beforeEach(() => {
        delete process.env[SWITCH_ENV];
        process.env[LIST_ENV] = DEMO;
      });

      it('lets the listed channel through on every new route', async () => {
        expect((await capabilities(DEMO)).status).toBe(200);
        expect((await items(DEMO)).status).toBe(200);
        expect((await like(DEMO, FB_COMMENT)).status).toBe(200);
      });

      it.each(routes)(
        'answers 403 not_demo_integration on %s for a channel off the list, with no database and no Graph call',
        async (_route, run) => {
          const res = await run();
          expect(res.status).toBe(403);
          expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
          nothingHappened();
        }
      );

      it('answers 403 for an id that is no Postiz id as well (not 404, no switch)', async () => {
        const res = await items('int.bad');
        expect(res.status).toBe(403);
        nothingHappened();
      });

      it('keeps the webhook routes for the listed channel', async () => {
        expect((await request('GET', '/webhooks/events')).status).toBe(200);
      });
    });

    describe('with the switch and no demo list', () => {
      it('serves a channel off any list on every new route', async () => {
        expect((await capabilities(FB_CHANNEL)).status).toBe(200);
        expect((await items(FB_CHANNEL)).status).toBe(200);
        expect((await comment(FB_CHANNEL, FB_COMMENT)).status).toBe(200);
        expect((await like(FB_CHANNEL, FB_COMMENT)).status).toBe(200);
        expect((await unlike(FB_CHANNEL, FB_COMMENT)).status).toBe(200);
        expect(repository.getChannelForInbox).toHaveBeenCalledWith(FB_CHANNEL);
      });

      it('serves the read of the demo (comments) for such a channel', async () => {
        graphHandler = ({ url }) =>
          url.pathname.endsWith('/published_posts')
            ? json({ data: [] })
            : json({ data: [] });
        expect(
          (await request('GET', `/integrations/${FB_CHANNEL}/comments`)).status
        ).toBe(200);
      });

      it.each([
        'int.bad',
        'int%20bad',
        'int%3Fx%3D1',
        'a'.repeat(65),
        'x%2F..',
      ])(
        'answers 404 not_found for the id "%s" without a database call',
        async (id) => {
          for (const run of [
            () => capabilities(id),
            () => items(id),
            () => comment(id, FB_COMMENT),
            () => like(id, FB_COMMENT),
          ]) {
            const res = await run();
            expect(res.status).toBe(404);
            expect(res.json()).toMatchObject({ code: 'not_found' });
          }
          nothingHappened();
          // Not the raw id in any log line.
          expect(logLines.join('\n')).not.toContain(id);
        }
      );

      it('answers 404 not_found for a valid id that is no channel', async () => {
        const res = await capabilities('int-unknown-1');
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
        expect(repository.getChannelForInbox).toHaveBeenCalledTimes(1);
        expect(graphCalls).toEqual([]);
      });

      it('still needs the service token on every route', async () => {
        for (const run of [
          () =>
            request('GET', `/integrations/${FB_CHANNEL}/capabilities`, {
              auth: '',
            }),
          () =>
            request('GET', `/integrations/${FB_CHANNEL}/items`, {
              auth: 'Bearer wrong',
            }),
          () =>
            request(
              'GET',
              `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}`,
              { auth: '' }
            ),
          () =>
            request(
              'POST',
              `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}/like`,
              { auth: 'Bearer wrong' }
            ),
          () =>
            request(
              'DELETE',
              `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}/like`,
              { auth: '' }
            ),
        ]) {
          expect((await run()).status).toBe(401);
        }
        nothingHappened();
      });

      it('answers 404 on the webhook routes, they stay with the demo list', async () => {
        expect(
          (await request('GET', `/integrations/${FB_CHANNEL}/webhooks`)).status
        ).toBe(404);
        expect(
          (await request('POST', `/integrations/${FB_CHANNEL}/webhooks`)).status
        ).toBe(404);
        expect((await request('GET', '/webhooks/events')).status).toBe(404);
        nothingHappened();
      });
    });

    describe('with the switch and a demo list', () => {
      beforeEach(() => {
        process.env[LIST_ENV] = DEMO;
      });

      it('serves a channel off the list on the new routes', async () => {
        expect((await items(FB_CHANNEL)).status).toBe(200);
        expect((await capabilities(IG_CHANNEL)).status).toBe(200);
      });

      it('keeps the webhook routes for the listed channels only', async () => {
        expect((await request('GET', '/webhooks/events')).status).toBe(200);
        const res = await request(
          'GET',
          `/integrations/${FB_CHANNEL}/webhooks`
        );
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        const sub = await request(
          'POST',
          `/integrations/${FB_CHANNEL}/webhooks`
        );
        expect(sub.status).toBe(403);
        expect(graphCalls).toEqual([]);
      });
    });
  });

  // Phase 3, PR 74: the routes that put our app on the Page of a channel
  // exist with the demo list or with YSOCIAL_INBOX_EVENTS=true, for every
  // channel with the switch. YSOCIAL_INBOX_ENABLED alone does not open them,
  // and the log of the events (/webhooks/events) stays with the demo list.
  describe('the switch YSOCIAL_INBOX_EVENTS and the webhook routes (PR 74)', () => {
    const getWebhooks = (id: string, opts?: any) =>
      request('GET', `/integrations/${id}/webhooks`, opts);
    const subscribe = (id: string, opts?: any) =>
      request('POST', `/integrations/${id}/webhooks`, opts);
    const eventsLog = (opts?: any) => request('GET', '/webhooks/events', opts);

    const webhookGraph = ({ method, url }: GraphCall): Response =>
      url.pathname.endsWith('/subscribed_apps')
        ? method === 'GET'
          ? json({ data: [{ id: APP_ID, subscribed_fields: ['feed'] }] })
          : json({ success: true })
        : json({ error: { message: 'unexpected call', code: 1 } }, 400);

    beforeEach(() => {
      graphHandler = webhookGraph;
    });

    const nothingHappened = () => {
      expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      expect(graphCalls).toEqual([]);
    };

    describe('with the switch and no demo list', () => {
      beforeEach(() => {
        delete process.env[SWITCH_ENV];
        delete process.env[LIST_ENV];
        process.env[EVENTS_ENV] = 'true';
      });

      it.each([
        ['facebook', FB_CHANNEL],
        ['instagram', IG_CHANNEL],
      ])(
        'answers whether the app is on the Page of a %s channel off any list',
        async (provider, channel) => {
          const res = await getWebhooks(channel);
          expect(res.status).toBe(200);
          expect(res.json()).toEqual({
            integrationId: channel,
            provider,
            subscribed: true,
            fields: ['feed'],
          });
          expect(repository.getChannelForInbox).toHaveBeenCalledWith(channel);
          expect(graphCalls).toHaveLength(1);
          expect(graphCalls[0].method).toBe('GET');
          expect(logLines).toEqual([
            `inbox webhooks channel=${channel} result=ok subscribed=true fields=feed`,
          ]);
        }
      );

      it('puts the app on the Page of a channel off any list, with the actor', async () => {
        const res = await subscribe(FB_CHANNEL);
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
          integrationId: FB_CHANNEL,
          provider: 'facebook',
          subscribed: true,
          fields: ['feed'],
        });
        expect(writes()).toHaveLength(1);
        expect(writes()[0].method).toBe('POST');
        expect(logLines).toEqual([
          `inbox subscribe channel=${FB_CHANNEL} actor=${ACTOR} result=done`,
        ]);
      });

      it('answers 400 actor_missing for the subscription without an actor, and does not call Meta', async () => {
        const res = await subscribe(FB_CHANNEL, { actor: null });
        expect(res.status).toBe(400);
        expect(res.json()).toMatchObject({ code: 'actor_missing' });
        nothingHappened();
      });

      it('still needs the service token', async () => {
        for (const auth of ['', 'Bearer wrong']) {
          expect((await getWebhooks(FB_CHANNEL, { auth })).status).toBe(401);
          expect((await subscribe(FB_CHANNEL, { auth })).status).toBe(401);
        }
        nothingHappened();
      });

      it('answers 503 without a configured service token', async () => {
        delete process.env[TOKEN_ENV];
        expect((await getWebhooks(FB_CHANNEL)).status).toBe(503);
        expect((await subscribe(FB_CHANNEL)).status).toBe(503);
        process.env[TOKEN_ENV] = serviceToken;
        nothingHappened();
      });

      it.each(['int.bad', 'int%20bad', 'a'.repeat(65), 'x%2F..'])(
        'answers 404 not_found for the id "%s" without a database or Graph call',
        async (id) => {
          for (const run of [() => getWebhooks(id), () => subscribe(id)]) {
            const res = await run();
            expect(res.status).toBe(404);
            expect(res.json()).toMatchObject({ code: 'not_found' });
          }
          nothingHappened();
          expect(logLines.join('\n')).not.toContain(id);
        }
      );

      it('answers 404 not_found for a valid id that is no channel', async () => {
        const res = await getWebhooks('int-unknown-1');
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
        expect(graphCalls).toEqual([]);
      });

      it('answers 409 channel_inactive for a disabled channel and calls nobody', async () => {
        repository.getChannelForInbox.mockResolvedValue({
          ...row(FB_CHANNEL),
          disabled: true,
        });
        for (const run of [
          () => getWebhooks(FB_CHANNEL),
          () => subscribe(FB_CHANNEL),
        ]) {
          const res = await run();
          expect(res.status).toBe(409);
          expect(res.json()).toMatchObject({ code: 'channel_inactive' });
        }
        expect(graphCalls).toEqual([]);
      });

      it('answers 409 provider_not_supported for a provider without an inbox', async () => {
        repository.getChannelForInbox.mockResolvedValue({
          ...row(FB_CHANNEL),
          providerIdentifier: 'x',
        });
        expect((await getWebhooks(FB_CHANNEL)).status).toBe(409);
        expect((await subscribe(FB_CHANNEL)).status).toBe(409);
        expect(graphCalls).toEqual([]);
      });

      it('does not open the log of the events: 404 before the token, nothing read', async () => {
        for (const auth of [`Bearer ${serviceToken}`, 'Bearer wrong', '']) {
          expect((await eventsLog({ auth })).status).toBe(404);
        }
        nothingHappened();
      });

      it('does not open the other inbox routes: 404 before the token, nothing touched', async () => {
        for (const auth of [`Bearer ${serviceToken}`, '']) {
          for (const [method, path] of [
            ['GET', `/integrations/${FB_CHANNEL}/capabilities`],
            ['GET', `/integrations/${FB_CHANNEL}/items`],
            ['GET', `/integrations/${FB_CHANNEL}/comments`],
            ['GET', `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}`],
            ['POST', `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}/like`],
            ['DELETE', `/integrations/${FB_CHANNEL}/comments/${FB_COMMENT}`],
          ] as const) {
            expect((await request(method, path, { auth })).status).toBe(404);
          }
        }
        nothingHappened();
      });
    });

    describe.each([
      ['no switch', undefined],
      ['the switch "false"', 'false'],
      ['the switch "TRUE"', 'TRUE'],
      ['the switch "1"', '1'],
      ['the switch ""', ''],
      ['the switch " true"', ' true'],
    ])(
      'with %s, no demo list and YSOCIAL_INBOX_ENABLED=true',
      (_name, value) => {
        beforeEach(() => {
          process.env[SWITCH_ENV] = 'true';
          delete process.env[LIST_ENV];
          if (value === undefined) {
            delete process.env[EVENTS_ENV];
          } else {
            process.env[EVENTS_ENV] = value;
          }
        });

        it('answers 404 on both webhook routes and the log, before the token', async () => {
          for (const auth of [`Bearer ${serviceToken}`, 'Bearer wrong', '']) {
            expect((await getWebhooks(FB_CHANNEL, { auth })).status).toBe(404);
            expect((await subscribe(FB_CHANNEL, { auth })).status).toBe(404);
            expect((await eventsLog({ auth })).status).toBe(404);
          }
          nothingHappened();
          expect(logLines).toEqual([]);
        });

        it('keeps the other inbox routes for the channel (the switch of PR 73)', async () => {
          graphHandler = facebookGraph;
          expect((await capabilities(FB_CHANNEL)).status).toBe(200);
        });
      }
    );

    describe('with the demo list and no switch', () => {
      beforeEach(() => {
        delete process.env[SWITCH_ENV];
        delete process.env[EVENTS_ENV];
        process.env[LIST_ENV] = DEMO;
      });

      it('serves the listed channel on the webhook routes', async () => {
        expect((await getWebhooks(DEMO)).status).toBe(200);
        expect((await subscribe(DEMO)).status).toBe(200);
        expect((await eventsLog()).status).toBe(200);
      });

      it('answers 403 not_demo_integration for a channel off the list, without a call', async () => {
        for (const run of [
          () => getWebhooks(FB_CHANNEL),
          () => subscribe(FB_CHANNEL),
        ]) {
          const res = await run();
          expect(res.status).toBe(403);
          expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        }
        nothingHappened();
        expect(logLines).toEqual([
          'inbox webhooks channel=- result=rejected code=not_demo_integration',
          `inbox subscribe channel=- actor=${ACTOR} result=rejected code=not_demo_integration`,
        ]);
      });

      it('answers 403, not 404, for an id that is no Postiz id (no switch)', async () => {
        const res = await getWebhooks('int.bad');
        expect(res.status).toBe(403);
        nothingHappened();
      });
    });

    describe('with the demo list and YSOCIAL_INBOX_ENABLED=true but not the events switch', () => {
      beforeEach(() => {
        process.env[SWITCH_ENV] = 'true';
        delete process.env[EVENTS_ENV];
        process.env[LIST_ENV] = DEMO;
      });

      it('does not widen the webhook routes: 403 for a channel off the list', async () => {
        expect((await getWebhooks(FB_CHANNEL)).status).toBe(403);
        expect((await subscribe(FB_CHANNEL)).status).toBe(403);
        nothingHappened();
      });

      it('serves the listed channel', async () => {
        expect((await getWebhooks(DEMO)).status).toBe(200);
      });
    });

    describe('with the demo list and the events switch', () => {
      beforeEach(() => {
        delete process.env[SWITCH_ENV];
        process.env[EVENTS_ENV] = 'true';
        process.env[LIST_ENV] = DEMO;
      });

      it('serves the listed channel and a channel off the list on the webhook routes', async () => {
        for (const channel of [DEMO, FB_CHANNEL]) {
          expect((await getWebhooks(channel)).status).toBe(200);
          expect((await subscribe(channel)).status).toBe(200);
        }
      });

      it('answers 404 not_found for an id that is no Postiz id (the switch is on)', async () => {
        const res = await getWebhooks('int.bad');
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'not_found' });
        nothingHappened();
      });

      it('keeps the log of the events and the inbox for the demo list', async () => {
        expect((await eventsLog()).status).toBe(200);
        graphHandler = facebookGraph;
        expect((await capabilities(DEMO)).status).toBe(200);
      });

      it('answers 403 not_demo_integration, not 404, on an inbox route for an id that is no Postiz id', async () => {
        graphHandler = facebookGraph;
        for (const run of [
          () => capabilities('int.bad'),
          () => items('int.bad'),
          () => comment('int.bad', FB_COMMENT),
        ]) {
          const res = await run();
          expect(res.status).toBe(403);
          expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        }
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(graphCalls).toEqual([]);
      });

      it('does not widen the other inbox routes: 403 not_demo_integration off the list', async () => {
        graphHandler = facebookGraph;
        for (const run of [
          () => capabilities(FB_CHANNEL),
          () => items(FB_CHANNEL),
          () => comment(FB_CHANNEL, FB_COMMENT),
          () => like(FB_CHANNEL, FB_COMMENT),
        ]) {
          const res = await run();
          expect(res.status).toBe(403);
          expect(res.json()).toMatchObject({ code: 'not_demo_integration' });
        }
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(graphCalls).toEqual([]);
      });
    });

    describe('with both switches and no demo list', () => {
      beforeEach(() => {
        process.env[SWITCH_ENV] = 'true';
        process.env[EVENTS_ENV] = 'true';
        delete process.env[LIST_ENV];
      });

      it('serves the webhook routes and the inbox, but not the log of the events', async () => {
        graphHandler = facebookGraph;
        expect((await capabilities(FB_CHANNEL)).status).toBe(200);
        graphHandler = webhookGraph;
        expect((await getWebhooks(FB_CHANNEL)).status).toBe(200);
        expect((await subscribe(FB_CHANNEL)).status).toBe(200);
        expect((await eventsLog()).status).toBe(404);
      });
    });
  });

  describe.each(platforms)('$name', (platform) => {
    const { channel } = platform;

    beforeEach(() => {
      graphHandler = platform.graph;
    });

    describe('capabilities', () => {
      it('answers what the platform allows, without a platform call', async () => {
        const res = await capabilities(channel);
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
          integrationId: channel,
          provider: platform.name,
          capabilities: {
            reply: true,
            hide: true,
            delete: true,
            like: platform.like,
            realtime: false,
          },
        });
        expect(graphCalls).toEqual([]);
        expect(logLines).toEqual([
          `inbox capabilities channel=${channel} result=ok`,
        ]);
      });

      it('answers 409 channel_inactive for a channel that is disabled', async () => {
        repository.getChannelForInbox.mockResolvedValue({
          ...row(channel),
          disabled: true,
        });
        const res = await capabilities(channel);
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'channel_inactive' });
      });
    });

    describe('items (QA 2)', () => {
      it('reads the window of 30 days and answers posts and flat items', async () => {
        const res = await items(channel);
        expect(res.status).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({
          integrationId: channel,
          provider: platform.name,
          since: null,
          postsBefore: null,
          nextCursor: null,
          usage: null,
        });
        expect(body.fetchedAt).toEqual(expect.any(String));
        const from = Date.parse(body.postsFrom);
        expect(Math.abs(Date.now() - 30 * 86_400_000 - from)).toBeLessThan(
          60_000
        );
        expect(body.posts).toHaveLength(1);
        expect(body.posts[0]).toMatchObject({
          id: platform.post,
          truncated: false,
        });
        expect(body.items.map((item: any) => [item.id, item.parentId])).toEqual(
          [
            [platform.comment, null],
            [platform.reply, platform.comment],
          ]
        );
        expect(
          body.items.every((item: any) => item.postId === platform.post)
        ).toBe(true);
        // Only GET calls, the token is the one of the channel.
        expect(writes()).toEqual([]);
        expect(graphCalls[0].url.searchParams.get('access_token')).toBe(
          pageToken
        );
        expect(logLines).toEqual([
          `inbox items channel=${channel} result=ok posts=1 items=2 next=no`,
        ]);
      });

      it('keeps only what is at or after since, and echoes since', async () => {
        // The comment is 24 h old, the reply 12 h: since 18 h ago.
        const since = new Date(Date.now() - 18 * 3_600_000).toISOString();
        const res = await items(channel, `?since=${encodeURIComponent(since)}`);
        expect(res.status).toBe(200);
        expect(res.json().since).toBe(since);
        expect(res.json().items.map((item: any) => item.id)).toEqual([
          platform.reply,
        ]);
        // The post stays listed.
        expect(res.json().posts).toHaveLength(1);
      });

      it('with olderThan reads the posts before it, with no lower bound', async () => {
        const olderThan = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const res = await items(
          channel,
          `?olderThan=${encodeURIComponent(olderThan)}`
        );
        expect(res.status).toBe(200);
        expect(res.json()).toMatchObject({
          postsFrom: null,
          postsBefore: olderThan,
          posts: [],
          items: [],
        });
      });

      it('passes the cursor on to the Graph API as after', async () => {
        const res = await items(channel, '?cursor=QVFIUk1_-%3D');
        expect(res.status).toBe(200);
        expect(graphCalls[0].url.searchParams.get('after')).toBe('QVFIUk1_-=');
        expect(pathOf(graphCalls[0])).toBe(platform.list);
      });

      it('answers nextCursor null at the end of the window', async () => {
        const res = await items(channel);
        expect(res.json().nextCursor).toBeNull();
        expect(logLines[0]).toContain('next=no');
      });

      it('answers nextCursor when the budget is used up, and the next call continues with it', async () => {
        const original = platform.graph;
        graphHandler = (call) => {
          wallClock += 30_000;
          const res = original(call);
          // A list answer with a second page.
          if (
            call.method === 'GET' &&
            pathOf(call) === platform.list &&
            !call.url.searchParams.get('after')
          ) {
            return res.json().then((body: any) =>
              json({
                ...body,
                paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
              })
            );
          }
          return res;
        };
        const first = await items(channel);
        expect(first.status).toBe(200);
        expect(first.json().nextCursor).toBe('PAGE2');
        expect(logLines[0]).toContain('next=yes');

        graphHandler = original;
        const second = await items(channel, '?cursor=PAGE2');
        expect(second.json().nextCursor).toBeNull();
        expect(
          graphCalls
            .filter((call) => pathOf(call) === platform.list)
            .map((call) => call.url.searchParams.get('after'))
        ).toEqual([null, 'PAGE2']);
      });

      it('answers the usage of Meta and logs it as a number', async () => {
        const original = platform.graph;
        graphHandler = (call) => {
          const res = original(call);
          return res.json().then((body: any) =>
            json(body, 200, {
              'x-business-use-case-usage': JSON.stringify({
                '10000000000001': [
                  {
                    type: 'pages',
                    call_count: 64,
                    total_cputime: 20,
                    total_time: 11,
                    estimated_time_to_regain_access: 6,
                  },
                ],
              }),
            })
          );
        };
        const res = await items(channel);
        expect(res.json().usage).toEqual({ percent: 64, regainMinutes: 6 });
        expect(res.text).not.toContain('10000000000001');
        expect(logLines).toEqual([
          `inbox items channel=${channel} result=ok posts=1 items=2 next=no usage=64`,
        ]);
      });

      it('answers usage null and logs no usage without the header', async () => {
        const res = await items(channel);
        expect(res.json().usage).toBeNull();
        expect(logLines.join('\n')).not.toContain('usage=');
      });

      it('ignores a header that is broken, in the answer and in the log', async () => {
        const original = platform.graph;
        graphHandler = (call) =>
          original(call)
            .json()
            .then((body: any) =>
              json(body, 200, { 'x-business-use-case-usage': '{"1": [' })
            );
        const res = await items(channel);
        expect(res.status).toBe(200);
        expect(res.json().usage).toBeNull();
        expect(logLines.join('\n')).not.toContain('usage=');
      });

      it('answers 502 platform_error with the log of the codes only', async () => {
        graphHandler = () =>
          json({ error: { message: META_MESSAGE, code: 190 } }, 401);
        const res = await items(channel);
        expect(res.status).toBe(502);
        expect(res.json()).toMatchObject({
          code: 'platform_error',
          platformStatus: 401,
          platformCode: 190,
        });
        expect(logLines).toEqual([
          `inbox items channel=${channel} result=rejected code=platform_error status=401 platform=190/-`,
        ]);
      });

      it('answers 503 platform_unavailable for a network error', async () => {
        graphHandler = () => {
          throw new Error(`fetch failed ${pageToken}`);
        };
        const res = await items(channel);
        expect(res.status).toBe(503);
        expect(res.json()).toMatchObject({ code: 'platform_unavailable' });
      });

      it('never writes on the platform', async () => {
        await items(channel);
        await capabilities(channel);
        await comment(channel, platform.comment);
        expect(writes()).toEqual([]);
      });
    });

    describe('query validation (QA 8)', () => {
      const bad = [
        ['since is no date', '?since=gestern'],
        ['since is not strict ISO (month 13)', '?since=2026-13-01T00:00:00Z'],
        ['since is a date without a time', '?since=2026-11-16'],
        ['since is a week date', '?since=2026-W47-1T10:00:00Z'],
        ['since is a basic date', '?since=20261117'],
        ['olderThan is a date without a time', '?olderThan=2026-10-01'],
        ['postsAfter is a date without a time', '?postsAfter=2026-10-01'],
        ['postsAfter is no date', '?postsAfter=gestern'],
        ['postsAfter is a week date', '?postsAfter=2026-W40'],
        ['since is empty', '?since='],
        ['olderThan is no date', '?olderThan=morgen'],
        ['olderThan has an impossible day', '?olderThan=2026-02-31T00:00:00Z'],
        ['cursor has a slash', '?cursor=abc%2Fdef'],
        ['cursor has an ampersand', '?cursor=abc%26access_token%3Dx'],
        ['cursor has a dot', '?cursor=a.b'],
        ['cursor has a space', '?cursor=a%20b'],
        ['cursor is empty', '?cursor='],
        ['cursor is 513 characters', `?cursor=${'a'.repeat(513)}`],
      ] as const;

      it.each(bad)(
        'answers 400 when %s, with no database and no Graph call',
        async (_name, query) => {
          const res = await items(channel, query);
          expect(res.status).toBe(400);
          expect(repository.getChannelForInbox).not.toHaveBeenCalled();
          expect(graphCalls).toEqual([]);
        }
      );

      it.each([
        '?since=2026-11-16T08:30:00.000Z',
        '?since=2026-11-16T08:30:00%2B01:00',
        '?olderThan=2026-10-01T00:00:00Z&postsAfter=2026-09-01T00:00:00Z',
        '?olderThan=2026-10-01T00:00:00Z',
        `?cursor=${'a'.repeat(512)}`,
        '?cursor=QVFIUk1_-%3D%3D',
        '?since=2026-11-16T08:30:00Z&olderThan=2026-10-01T00:00:00Z&cursor=abc',
      ])('accepts %s', async (query) => {
        expect((await items(channel, query)).status).toBe(200);
      });
    });

    describe('one comment (QA 2)', () => {
      it('answers the conversation of a comment of this channel', async () => {
        const res = await comment(channel, platform.comment);
        expect(res.status).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({
          integrationId: channel,
          provider: platform.name,
          commentId: platform.comment,
          usage: null,
        });
        expect(body.post).toMatchObject({ id: platform.post });
        expect(body.items.map((item: any) => item.id)).toEqual([
          platform.comment,
          platform.reply,
        ]);
        expect(logLines).toEqual([
          `inbox comment channel=${channel} comment=${platform.comment} result=ok items=2`,
        ]);
        expect(writes()).toEqual([]);
      });

      it('answers the whole thread for a reply', async () => {
        const res = await comment(channel, platform.reply);
        expect(res.status).toBe(200);
        expect(res.json().items.map((item: any) => item.id)).toEqual([
          platform.comment,
          platform.reply,
        ]);
      });

      it('answers 404 comment_not_found for a comment of someone else', async () => {
        const res = await comment(channel, platform.foreign);
        expect(res.status).toBe(404);
        expect(res.json()).toMatchObject({ code: 'comment_not_found' });
        expect(logLines).toEqual([
          `inbox comment channel=${channel} comment=${platform.foreign} result=rejected code=comment_not_found`,
        ]);
      });

      it('answers 400 invalid_comment_id with no database and no Graph call', async () => {
        for (const id of ['abc', '1.2', '1-2', 'x'.repeat(65)]) {
          const res = await comment(channel, id);
          expect(res.status).toBe(400);
          expect(res.json()).toMatchObject({ code: 'invalid_comment_id' });
        }
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(graphCalls).toEqual([]);
        // The raw id is in no log line.
        expect(logLines.join('\n')).toContain('comment=-');
        expect(logLines.join('\n')).not.toContain('abc');
      });

      it('answers 502 for an error of Meta, with usage in the log only when sent', async () => {
        graphHandler = () =>
          json({ error: { message: META_MESSAGE, code: 190 } }, 401);
        const res = await comment(channel, platform.comment);
        expect(res.status).toBe(502);
        expect(logLines.join('\n')).not.toContain('usage=');
      });
    });

    describe('like (QA 2)', () => {
      if (platform.like) {
        it('likes with one POST to /{comment}/likes and answers liked true', async () => {
          const res = await like(channel, platform.comment);
          expect(res.status).toBe(200);
          expect(res.json()).toEqual({
            integrationId: channel,
            commentId: platform.comment,
            liked: true,
          });
          expect(writes()).toHaveLength(1);
          expect(writes()[0].method).toBe('POST');
          expect(pathOf(writes()[0])).toBe(`/${platform.comment}/likes`);
          expect(logLines).toEqual([
            `inbox like channel=${channel} comment=${platform.comment} actor=${ACTOR} result=done`,
          ]);
        });

        it('likes a reply that the window lists', async () => {
          const res = await like(channel, platform.reply);
          expect(res.status).toBe(200);
          expect(pathOf(writes()[0])).toBe(`/${platform.reply}/likes`);
        });

        it('takes the like back with one DELETE and answers liked false', async () => {
          const res = await unlike(channel, platform.comment);
          expect(res.status).toBe(200);
          expect(res.json()).toMatchObject({ liked: false });
          expect(writes()).toHaveLength(1);
          expect(writes()[0].method).toBe('DELETE');
          expect(pathOf(writes()[0])).toBe(`/${platform.comment}/likes`);
          expect(logLines).toEqual([
            `inbox unlike channel=${channel} comment=${platform.comment} actor=${ACTOR} result=done`,
          ]);
        });

        it('answers 404 comment_not_found for a comment of someone else, and does not write', async () => {
          for (const run of [
            () => like(channel, platform.foreign),
            () => unlike(channel, platform.foreign),
          ]) {
            const res = await run();
            expect(res.status).toBe(404);
            expect(res.json()).toMatchObject({ code: 'comment_not_found' });
          }
          expect(writes()).toEqual([]);
        });

        it('answers 502 when Meta does not confirm with success: true', async () => {
          const original = platform.graph;
          graphHandler = (call) =>
            call.method === 'GET' ? original(call) : json({ success: false });
          const res = await like(channel, platform.comment);
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({ code: 'platform_error' });
        });

        it('answers 502 for a refusal of Meta and 503 outcome_unknown for an HTTP 500, one attempt each', async () => {
          const original = platform.graph;
          graphHandler = (call) =>
            call.method === 'GET'
              ? original(call)
              : json({ error: { message: META_MESSAGE, code: 200 } }, 403);
          expect((await like(channel, platform.comment)).status).toBe(502);

          graphCalls.length = 0;
          graphHandler = (call) =>
            call.method === 'GET'
              ? original(call)
              : json({ error: { message: META_MESSAGE, code: 2 } }, 500);
          const res = await like(channel, platform.comment);
          expect(res.status).toBe(503);
          expect(res.json()).toMatchObject({ code: 'outcome_unknown' });
          expect(writes()).toHaveLength(1);
        });
      } else {
        it('answers 409 action_not_supported without any platform call', async () => {
          for (const run of [
            () => like(channel, platform.comment),
            () => unlike(channel, platform.comment),
            () => like(channel, platform.foreign),
          ]) {
            const res = await run();
            expect(res.status).toBe(409);
            expect(res.json()).toMatchObject({
              code: 'action_not_supported',
              provider: platform.name,
            });
          }
          // Not even the ownership read: the check comes first.
          expect(graphCalls).toEqual([]);
          expect(logLines[0]).toBe(
            `inbox like channel=${channel} comment=${platform.comment} actor=${ACTOR} result=rejected code=action_not_supported`
          );
        });
      }

      it('answers 400 actor_missing without a header, and calls nothing', async () => {
        for (const run of [
          () => like(channel, platform.comment, { actor: null }),
          () => unlike(channel, platform.comment, { actor: null }),
        ]) {
          const res = await run();
          expect(res.status).toBe(400);
          expect(res.json()).toMatchObject({ code: 'actor_missing' });
        }
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(graphCalls).toEqual([]);
      });

      it('answers 400 invalid_comment_id with no database and no Graph call', async () => {
        const res = await like(channel, '1.2');
        expect(res.status).toBe(400);
        expect(res.json()).toMatchObject({ code: 'invalid_comment_id' });
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
        expect(graphCalls).toEqual([]);
      });

      it('answers 404 not_found for an unknown channel and does not write', async () => {
        const res = await like('int-unknown-1', platform.comment);
        expect(res.status).toBe(404);
        expect(writes()).toEqual([]);
      });
    });
  });

  describe('after the review (PR 73)', () => {
    const FOREIGN_POST = '100000000000999_200000000000001';
    const withPost = (path: string, postId: string | null) =>
      postId === null ? path : `${path}?postId=${postId}`;

    const reply = (id: string, commentId: string, postId: string | null) =>
      request(
        'POST',
        withPost(`/integrations/${id}/comments/${commentId}/replies`, postId),
        { body: { message: REPLY_TEXT } }
      );
    const hide = (id: string, commentId: string, postId: string | null) =>
      request(
        'POST',
        withPost(`/integrations/${id}/comments/${commentId}/hide`, postId),
        { body: { hide: true } }
      );
    const remove = (id: string, commentId: string, postId: string | null) =>
      request(
        'DELETE',
        withPost(`/integrations/${id}/comments/${commentId}`, postId),
        {
          body: { confirmDelete: true },
        }
      );
    const commentOf = (id: string, commentId: string, postId: string | null) =>
      request(
        'GET',
        withPost(`/integrations/${id}/comments/${commentId}`, postId)
      );
    const likeOf = (id: string, commentId: string, postId: string | null) =>
      request(
        'POST',
        withPost(`/integrations/${id}/comments/${commentId}/like`, postId)
      );
    const unlikeOf = (id: string, commentId: string, postId: string | null) =>
      request(
        'DELETE',
        withPost(`/integrations/${id}/comments/${commentId}/like`, postId)
      );

    describe('postId on every route of one comment (DTO)', () => {
      const routes = [
        ['getComment', (q: string) => commentOf(FB_CHANNEL, FB_COMMENT, q)],
        ['like', (q: string) => likeOf(FB_CHANNEL, FB_COMMENT, q)],
        ['unlike', (q: string) => unlikeOf(FB_CHANNEL, FB_COMMENT, q)],
        ['reply', (q: string) => reply(FB_CHANNEL, FB_COMMENT, q)],
        ['hide', (q: string) => hide(FB_CHANNEL, FB_COMMENT, q)],
        ['delete', (q: string) => remove(FB_CHANNEL, FB_COMMENT, q)],
      ] as const;

      beforeEach(() => {
        graphHandler = facebookGraph;
      });

      describe.each(routes)('%s', (_name, run) => {
        it.each([
          'abc',
          '1.2',
          '1%2F2',
          '..%2Fme',
          '1-2',
          '1%20',
          '',
          '9'.repeat(65),
        ])(
          'answers 400 for postId "%s", with no database and no Graph call',
          async (postId) => {
            const res = await run(postId);
            expect(res.status).toBe(400);
            expect(repository.getChannelForInbox).not.toHaveBeenCalled();
            expect(graphCalls).toEqual([]);
          }
        );
      });
    });

    describe('facebook with postId', () => {
      beforeEach(() => {
        graphHandler = facebookGraph;
      });
      const reads = () =>
        graphCalls
          .filter((call) => call.method === 'GET')
          .map((call) => pathOf(call));

      it('answers the conversation after the check of the post, without the list of posts', async () => {
        const res = await commentOf(FB_CHANNEL, FB_COMMENT, FB_POST);
        expect(res.status).toBe(200);
        expect(res.json()).toMatchObject({
          commentId: FB_COMMENT,
          post: { id: FB_POST },
        });
        expect(res.json().items.map((item: any) => item.id)).toEqual([
          FB_COMMENT,
          FB_REPLY,
        ]);
        expect(reads()).toEqual([
          `/${FB_POST}`,
          `/${FB_POST}/comments`,
          `/${FB_COMMENT}`,
        ]);
        expect(writes()).toEqual([]);
      });

      it('lets each write through after the check of the post: two reads, then one write', async () => {
        const cases = [
          [
            'reply',
            () => reply(FB_CHANNEL, FB_COMMENT, FB_POST),
            'POST',
            `/${FB_COMMENT}/comments`,
          ],
          [
            'hide',
            () => hide(FB_CHANNEL, FB_COMMENT, FB_POST),
            'POST',
            `/${FB_COMMENT}`,
          ],
          [
            'delete',
            () => remove(FB_CHANNEL, FB_COMMENT, FB_POST),
            'DELETE',
            `/${FB_COMMENT}`,
          ],
          [
            'like',
            () => likeOf(FB_CHANNEL, FB_COMMENT, FB_POST),
            'POST',
            `/${FB_COMMENT}/likes`,
          ],
          [
            'unlike',
            () => unlikeOf(FB_CHANNEL, FB_COMMENT, FB_POST),
            'DELETE',
            `/${FB_COMMENT}/likes`,
          ],
        ] as const;
        for (const [, run, method, path] of cases) {
          graphCalls.length = 0;
          const res = await run();
          expect([200, 201]).toContain(res.status);
          // The check of the post and of the comment: no thread read, no
          // list of posts. Then exactly the write.
          expect(reads()).toEqual([`/${FB_POST}`, `/${FB_POST}/comments`]);
          expect(writes()).toHaveLength(1);
          expect(writes()[0].method).toBe(method);
          expect(pathOf(writes()[0])).toBe(path);
        }
      });

      it('answers 404 comment_not_found for a post of another Page: no Graph call, no write', async () => {
        for (const run of [
          () => commentOf(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
          () => reply(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
          () => hide(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
          () => remove(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
          () => likeOf(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
          () => unlikeOf(FB_CHANNEL, FB_COMMENT, FOREIGN_POST),
        ]) {
          const res = await run();
          expect(res.status).toBe(404);
          expect(res.json()).toMatchObject({ code: 'comment_not_found' });
        }
        expect(graphCalls).toEqual([]);
      });

      it('answers 404 when the post is not from the Page, and writes nothing', async () => {
        graphHandler = (call) =>
          pathOf(call) === `/${FB_POST}`
            ? json({ id: FB_POST, from: { id: '100000000000999' } })
            : facebookGraph(call);
        for (const run of [
          () => commentOf(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => reply(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => remove(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => likeOf(FB_CHANNEL, FB_COMMENT, FB_POST),
        ]) {
          expect((await run()).status).toBe(404);
        }
        expect(writes()).toEqual([]);
        expect(reads().every((path) => path === `/${FB_POST}`)).toBe(true);
      });

      it('answers 404 when the comment is not under the post, and writes nothing', async () => {
        graphHandler = (call) =>
          pathOf(call) === `/${FB_POST}/comments`
            ? json({ data: [{ id: FB_FOREIGN }] })
            : facebookGraph(call);
        for (const run of [
          () => commentOf(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => reply(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => hide(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => remove(FB_CHANNEL, FB_COMMENT, FB_POST),
          () => likeOf(FB_CHANNEL, FB_COMMENT, FB_POST),
        ]) {
          const res = await run();
          expect(res.status).toBe(404);
          expect(res.json()).toMatchObject({ code: 'comment_not_found' });
        }
        expect(writes()).toEqual([]);
      });

      describe('the search runs out of time', () => {
        // The first stream page has a next page and takes 30 s.
        const slow = (headers: Record<string, string> = {}) => {
          graphHandler = (call) => {
            if (pathOf(call) === `/${FB_POST}/comments`) {
              wallClock += 30_000;
              return json(
                {
                  data: [{ id: FB_FOREIGN }],
                  paging: { next: 'https://x', cursors: { after: 'P2' } },
                },
                200,
                headers
              );
            }
            return facebookGraph(call);
          };
        };

        it('answers 503 ownership_unknown on every write, and writes nothing', async () => {
          slow();
          const cases = [
            ['reply', () => reply(FB_CHANNEL, FB_COMMENT, FB_POST)],
            ['hide', () => hide(FB_CHANNEL, FB_COMMENT, FB_POST)],
            ['delete', () => remove(FB_CHANNEL, FB_COMMENT, FB_POST)],
            ['like', () => likeOf(FB_CHANNEL, FB_COMMENT, FB_POST)],
          ] as const;
          for (const [action, run] of cases) {
            logLines.length = 0;
            const res = await run();
            expect(res.status).toBe(503);
            expect(res.json()).toMatchObject({ code: 'ownership_unknown' });
            expect(logLines).toEqual([
              `inbox ${action} channel=${FB_CHANNEL} comment=${FB_COMMENT} actor=${ACTOR} result=rejected code=ownership_unknown`,
            ]);
          }
          expect(writes()).toEqual([]);
        });

        it('answers 503 ownership_unknown on getComment with the usage so far', async () => {
          slow({
            'x-business-use-case-usage': JSON.stringify({
              '1': [{ call_count: 64 }],
            }),
          });
          const res = await commentOf(FB_CHANNEL, FB_COMMENT, FB_POST);
          expect(res.status).toBe(503);
          expect(res.json()).toMatchObject({
            code: 'ownership_unknown',
            usage: { percent: 64 },
          });
          expect(logLines).toEqual([
            `inbox comment channel=${FB_CHANNEL} comment=${FB_COMMENT} result=rejected code=ownership_unknown usage=64`,
          ]);
        });

        it('answers ownership_unknown without usage when Meta sent no header', async () => {
          slow();
          const res = await commentOf(FB_CHANNEL, FB_COMMENT, FB_POST);
          expect(res.status).toBe(503);
          expect(res.json()).not.toHaveProperty('usage');
          expect(logLines.join('\n')).not.toContain('usage=');
        });
      });
    });

    describe('instagram with postId', () => {
      beforeEach(() => {
        graphHandler = instagramGraph;
      });

      it('ignores postId on a read: the same answer and no postId in a URL', async () => {
        const plain = await commentOf(IG_CHANNEL, IG_COMMENT, null);
        const calls = graphCalls.map((call) => call.url.pathname);
        graphCalls.length = 0;
        const hinted = await commentOf(IG_CHANNEL, IG_COMMENT, IG_MEDIA);
        expect(hinted.status).toBe(200);
        const shape = (res: any) =>
          res.json().items.map((item: any) => [item.id, item.fromOwner]);
        expect(shape(hinted)).toEqual(shape(plain));
        expect(graphCalls.map((call) => call.url.pathname)).toEqual(calls);
        expect(graphCalls.map((call) => call.url.href).join(' ')).not.toContain(
          'postId'
        );
      });

      it('ignores postId on a write: the same check by media owner, one write', async () => {
        const res = await reply(IG_CHANNEL, IG_COMMENT, IG_FOREIGN_MEDIA);
        expect(res.status).toBe(201);
        expect(writes()).toHaveLength(1);
        expect(pathOf(writes()[0])).toBe(`/${IG_COMMENT}/replies`);
        // The foreign media in the hint changed nothing.
        expect(
          graphCalls.some((call) => pathOf(call).includes(IG_FOREIGN_MEDIA))
        ).toBe(false);
      });

      it('still answers 404 for a comment on media of another account, with a hint', async () => {
        const res = await reply(IG_CHANNEL, IG_FOREIGN, IG_MEDIA);
        expect(res.status).toBe(404);
        expect(writes()).toEqual([]);
      });
    });

    describe.each(platforms)('$name', (platform) => {
      const { channel } = platform;
      beforeEach(() => {
        graphHandler = platform.graph;
      });

      it('marks the comments of the account itself as fromOwner, and nothing else leaves', async () => {
        const res = await items(channel);
        expect(res.status).toBe(200);
        expect(
          res.json().items.map((item: any) => [item.id, item.fromOwner])
        ).toEqual([
          [platform.comment, false],
          [platform.reply, true],
        ]);
        expect(res.text).not.toContain('500000000000777');
      });

      it('marks fromOwner in the conversation of one comment', async () => {
        const res = await comment(channel, platform.comment);
        expect(
          res.json().items.map((item: any) => [item.id, item.fromOwner])
        ).toEqual([
          [platform.comment, false],
          [platform.reply, true],
        ]);
      });

      it('takes postsAfter as the lower bound with olderThan, and echoes both', async () => {
        const olderThan = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const postsAfter = new Date(Date.now() - 60 * 86_400_000).toISOString();
        const res = await items(
          channel,
          `?olderThan=${encodeURIComponent(
            olderThan
          )}&postsAfter=${encodeURIComponent(postsAfter)}`
        );
        expect(res.status).toBe(200);
        expect(res.json()).toMatchObject({
          postsFrom: postsAfter,
          postsBefore: olderThan,
        });
      });

      it('ignores postsAfter without olderThan: the window of 30 days stays', async () => {
        const postsAfter = new Date(Date.now() - 60 * 86_400_000).toISOString();
        const res = await items(
          channel,
          `?postsAfter=${encodeURIComponent(postsAfter)}`
        );
        expect(res.status).toBe(200);
        const from = Date.parse(res.json().postsFrom);
        expect(Math.abs(Date.now() - 30 * 86_400_000 - from)).toBeLessThan(
          60_000
        );
        expect(res.json().postsBefore).toBeNull();
      });

      describe('usage on an error of a read route', () => {
        const header = {
          'x-business-use-case-usage': JSON.stringify({
            '1': [{ call_count: 64, estimated_time_to_regain_access: 3 }],
          }),
        };

        it('items: 502 carries usage in the body and at the end of the log line', async () => {
          graphHandler = () =>
            json({ error: { message: META_MESSAGE, code: 4 } }, 429, header);
          const res = await items(channel);
          expect(res.status).toBe(502);
          expect(res.json()).toMatchObject({
            code: 'platform_error',
            platformStatus: 429,
            usage: { percent: 64, regainMinutes: 3 },
          });
          expect(logLines).toEqual([
            `inbox items channel=${channel} result=rejected code=platform_error status=429 platform=4/- usage=64`,
          ]);
        });

        it('comment: 502 carries usage as well', async () => {
          graphHandler = () =>
            json({ error: { message: META_MESSAGE, code: 4 } }, 429, header);
          const res = await comment(channel, platform.comment);
          expect(res.status).toBe(502);
          expect(res.json().usage).toEqual({ percent: 64, regainMinutes: 3 });
          expect(logLines[0]).toMatch(/ usage=64$/);
        });

        it('items: 503 platform_unavailable on a later page carries the usage of the first', async () => {
          const original = platform.graph;
          graphHandler = (call) => {
            if (pathOf(call) !== platform.list) {
              return original(call);
            }
            if (call.url.searchParams.get('after')) {
              throw new Error(`fetch failed ${pageToken}`);
            }
            return original(call)
              .json()
              .then((body: any) =>
                json(
                  {
                    ...body,
                    paging: { next: 'https://x', cursors: { after: 'P2' } },
                  },
                  200,
                  header
                )
              );
          };
          const res = await items(channel);
          expect(res.status).toBe(503);
          expect(res.json()).toMatchObject({
            code: 'platform_unavailable',
            usage: { percent: 64 },
          });
          expect(logLines).toEqual([
            `inbox items channel=${channel} result=rejected code=platform_unavailable usage=64`,
          ]);
        });

        it('has no usage in the body or the log of an error without a header', async () => {
          graphHandler = () =>
            json({ error: { message: META_MESSAGE, code: 190 } }, 401);
          const res = await items(channel);
          expect(res.json()).not.toHaveProperty('usage');
          expect(logLines.join('\n')).not.toContain('usage=');
        });

        it('a write does not carry usage in its error', async () => {
          if (!platform.like) {
            return;
          }
          const original = platform.graph;
          graphHandler = (call) =>
            call.method === 'GET'
              ? original(call)
              : json(
                  { error: { message: META_MESSAGE, code: 200 } },
                  403,
                  header
                );
          const res = await likeOf(channel, platform.comment, null);
          expect(res.status).toBe(502);
          expect(res.json()).not.toHaveProperty('usage');
        });
      });
    });

    describe('webhook routes before the token', () => {
      it('answers 404 with the switch and no demo list, also with a wrong or no token', async () => {
        for (const auth of ['', 'Bearer wrong', `Bearer ${serviceToken}`]) {
          for (const [method, path] of [
            ['GET', `/integrations/${FB_CHANNEL}/webhooks`],
            ['POST', `/integrations/${FB_CHANNEL}/webhooks`],
            ['GET', '/webhooks/events'],
          ] as const) {
            expect((await request(method, path, { auth })).status).toBe(404);
          }
        }
        expect(repository.getChannelForInbox).not.toHaveBeenCalled();
      });

      it('answers 401 without a token once the demo list is set', async () => {
        process.env[LIST_ENV] = DEMO;
        expect(
          (await request('GET', '/webhooks/events', { auth: '' })).status
        ).toBe(401);
        expect(
          (
            await request('GET', `/integrations/${DEMO}/webhooks`, {
              auth: 'Bearer wrong',
            })
          ).status
        ).toBe(401);
      });
    });
  });

  describe('mentions (W76)', () => {
    // Facebook as the platform sends it, with message_tags on the comment
    // and on its reply, including ids, types and positions.
    const tags = (names: string[]) =>
      names.map((name, i) => ({
        id: `60000000000000${i}`,
        name,
        type: i === 0 ? 'user' : 'page',
        offset: i * 10,
        length: name.length,
      }));
    const tagged =
      (byId: Record<string, unknown[]>) =>
      async (call: GraphCall): Promise<Response> => {
        const res = facebookGraph(call);
        const walk = (value: any): any => {
          if (Array.isArray(value)) {
            return value.map(walk);
          }
          if (value && typeof value === 'object') {
            const out: any = {};
            for (const [key, inner] of Object.entries(value)) {
              out[key] = walk(inner);
            }
            if (typeof value.id === 'string' && byId[value.id]) {
              out.message_tags = byId[value.id];
            }
            return out;
          }
          return value;
        };
        return json(walk(await res.json()), res.status);
      };
    const TAGS = {
      [FB_COMMENT]: tags([MENTION_PERSON, MENTION_PAGE]),
      [FB_REPLY]: tags([MENTION_PAGE]),
    };

    it.each([
      ['items', () => items(FB_CHANNEL)],
      ['comments/:commentId', () => comment(FB_CHANNEL, FB_COMMENT)],
    ])('%s answers mentions as an array of names, no ids', async (_, read) => {
      graphHandler = tagged(TAGS);
      const res = await read();
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.items.map((item: any) => [item.id, item.mentions])).toEqual([
        // The first tag also covers the first 14 characters of the text of
        // the comment, the others reach past the end of their text.
        [FB_COMMENT, [MENTION_PERSON, 'Erfundener Kom', MENTION_PAGE]],
        [FB_REPLY, [MENTION_PAGE]],
      ]);
      for (const item of body.items) {
        expect(
          item.mentions.every((name: unknown) => typeof name === 'string')
        ).toBe(true);
      }
      // No id, type or position of a tag leaves.
      expect(res.text).not.toContain('60000000000000');
      expect(res.text).not.toContain('message_tags');
      expect(res.text).not.toContain('"offset"');
      // The names are in no log line (the check after each test too).
      expect(logLines.join('\n')).not.toContain(MENTION_PERSON);
      expect(logLines.join('\n')).not.toContain(MENTION_PAGE);
      expect(logLines).toHaveLength(1);
      expect(writes()).toEqual([]);
    });

    it.each([
      ['items', () => items(FB_CHANNEL)],
      ['comments/:commentId', () => comment(FB_CHANNEL, FB_COMMENT)],
    ])(
      '%s answers the tagged part of the text, in no log line',
      async (_, read) => {
        const handler = tagged({
          [FB_COMMENT]: [
            {
              id: '600000000000009',
              name: MENTION_PERSON,
              type: 'user',
              offset: 6,
              length: MENTION_PART.length,
            },
          ],
        });
        graphHandler = async (call) => {
          const res = await handler(call);
          const walk = (value: any): any => {
            if (Array.isArray(value)) {
              return value.map(walk);
            }
            if (value && typeof value === 'object') {
              const out: any = {};
              for (const [key, inner] of Object.entries(value)) {
                out[key] = walk(inner);
              }
              if (value.id === FB_COMMENT) {
                out.message = MENTION_PART_TEXT;
              }
              return out;
            }
            return value;
          };
          return json(walk(await res.json()), res.status);
        };
        const res = await read();
        expect(res.status).toBe(200);
        const body = res.json();
        expect(
          body.items.find((item: any) => item.id === FB_COMMENT).mentions
        ).toEqual([MENTION_PERSON, MENTION_PART]);
        expect(res.text).not.toContain('600000000000009');
        expect(res.text).not.toContain('"offset"');
        // Neither the name nor the part in a log line (the check after each
        // test too).
        expect(logLines.join('\n')).not.toContain(MENTION_PERSON);
        expect(logLines.join('\n')).not.toContain(MENTION_PART);
        expect(writes()).toEqual([]);
      }
    );

    it('answers mentions [] when the platform sends no tags', async () => {
      graphHandler = facebookGraph;
      for (const res of [
        await items(FB_CHANNEL),
        await comment(FB_CHANNEL, FB_COMMENT),
      ]) {
        expect(res.status).toBe(200);
        expect(res.json().items.map((item: any) => item.mentions)).toEqual([
          [],
          [],
        ]);
      }
    });

    it('answers mentions [] for every Instagram entry, tags or not', async () => {
      graphHandler = instagramGraph;
      for (const res of [
        await items(IG_CHANNEL),
        await comment(IG_CHANNEL, IG_COMMENT),
      ]) {
        expect(res.status).toBe(200);
        expect(res.json().items.map((item: any) => item.mentions)).toEqual([
          [],
          [],
        ]);
      }
    });
  });

  describe('every write on a channel off the demo list, with a demo list set', () => {
    it('answers 403 and does not call the platform, for like and unlike', async () => {
      process.env[SWITCH_ENV] = 'false';
      process.env[LIST_ENV] = DEMO;
      graphHandler = facebookGraph;
      expect((await like(FB_CHANNEL, FB_COMMENT)).status).toBe(403);
      expect((await unlike(FB_CHANNEL, FB_COMMENT)).status).toBe(403);
      expect((await like(IG_CHANNEL, IG_COMMENT)).status).toBe(403);
      expect(graphCalls).toEqual([]);
      expect(repository.getChannelForInbox).not.toHaveBeenCalled();
    });
  });

  describe('a Postiz channel of another provider', () => {
    it('answers 409 provider_not_supported on the new routes', async () => {
      process.env[SWITCH_ENV] = 'true';
      repository.getChannelForInbox.mockResolvedValue({
        ...row(FB_CHANNEL),
        providerIdentifier: 'x',
      });
      for (const run of [
        () => capabilities(FB_CHANNEL),
        () => items(FB_CHANNEL),
        () => comment(FB_CHANNEL, FB_COMMENT),
        () => like(FB_CHANNEL, FB_COMMENT),
      ]) {
        const res = await run();
        expect(res.status).toBe(409);
        expect(res.json()).toMatchObject({ code: 'provider_not_supported' });
      }
      expect(graphCalls).toEqual([]);
    });
  });
});
