// The real PostsService pulls in half of Postiz, some of it ESM-only.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { createHmac, randomBytes } from 'crypto';
import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialModule } from './ysocial.module';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialMetaWebhookService } from '../../../../libraries/ysocial/src/webhooks/ysocial.meta.webhook.service';
import { WEBHOOK_LOG_KEY } from '../../../../libraries/ysocial/src/webhooks/webhook.rules';

const LIST_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
const VERIFY_ENV = 'YSOCIAL_META_WEBHOOK_VERIFY_TOKEN';
const SECRET_ENV = 'FACEBOOK_APP_SECRET';
const ENVS = [LIST_ENV, VERIFY_ENV, SECRET_ENV];

const verifyToken = randomBytes(32).toString('hex');
const appSecret = randomBytes(24).toString('hex');

// Invented data only.
const CHANNEL = 'int-demo-fb-1';
const PAGE = '100000000000001';
const POST = `${PAGE}_200000000000001`;
const COMMENT = `${POST}_300000000000001`;
const COMMENT_TEXT = 'Erfundener Kommentar';
const COMMENTER = 'Erfundene Person';
const COMMENTER_NAME = 'erfundene_person';
const COMMENTER_ID = '500000000000777';
const CHALLENGE = '1158201444';

const notification = (commentId = COMMENT) => ({
  object: 'page',
  entry: [
    {
      id: PAGE,
      time: 1_795_000_100,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            post_id: POST,
            comment_id: commentId,
            parent_id: POST,
            created_time: 1_795_000_000,
            message: COMMENT_TEXT,
            from: { name: COMMENTER, id: COMMENTER_ID },
          },
        },
      ],
    },
  ],
});

const instagramNotification = () => ({
  object: 'instagram',
  entry: [
    {
      id: '17840000000000001',
      time: 1_795_000_100,
      changes: [
        {
          field: 'comments',
          value: {
            id: '17950000000000001',
            text: COMMENT_TEXT,
            from: { id: COMMENTER_ID, username: COMMENTER_NAME },
            media: { id: '17900000000000001' },
          },
        },
      ],
    },
  ],
});

const sign = (body: string, secret = appSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

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
class WebhookTestModule {}

// Stand-in for the Redis list. The mock of Postiz without REDIS_URL has no
// ltrim, so the test sets the store of the service instead.
class FakeStore {
  list: string[] = [];
  ops: string[] = [];
  failing = false;
  async rpush(key: string, value: string) {
    this.ops.push(`rpush ${key}`);
    if (this.failing) {
      throw new Error('store down');
    }
    this.list.push(value);
    return this.list.length;
  }
  async ltrim(key: string, start: number, stop: number) {
    this.ops.push(`ltrim ${key} ${start} ${stop}`);
    return 'OK';
  }
  async expire(key: string, seconds: number) {
    this.ops.push(`expire ${key} ${seconds}`);
    return 1;
  }
  async lrange() {
    return [...this.list];
  }
}

describe('/ysocial-meta-webhook', () => {
  const savedEnv = ENVS.map((name) => process.env[name]);
  const realFetch = global.fetch;
  let app: INestApplication;
  let baseUrl: string;
  let store: FakeStore;
  let graphCalls: string[];
  let logLines: string[];
  let responses: string[];
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WebhookTestModule, YsocialModule],
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
    store = new FakeStore();
    moduleRef.get(YsocialMetaWebhookService)['store'] = store;
    // rawBody like NestFactory.create in apps/backend/src/main.ts, the
    // signature is computed over it.
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
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
    process.env[LIST_ENV] = CHANNEL;
    process.env[VERIFY_ENV] = verifyToken;
    process.env[SECRET_ENV] = appSecret;
    store.list = [];
    store.ops = [];
    store.failing = false;
    graphCalls = [];
    responses = [];

    // Rule 2: the receiver calls nobody. Every call to Meta is recorded, the
    // test itself calls the server with fetch.
    global.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (/^https?:\/\/[^/]*(facebook|instagram|fbcdn)\./.test(url)) {
        graphCalls.push(url);
        throw new Error('no network in this test');
      }
      return realFetch(input, init);
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

    // In every case: no call to Meta, no token, signature, secret, comment
    // text or name in a log line, none of them in an answer either.
    expect(graphCalls).toEqual([]);
    const log = logLines.join('\n');
    for (const secret of [
      verifyToken,
      appSecret,
      sign(JSON.stringify(notification())),
      CHALLENGE,
      COMMENT_TEXT,
      COMMENTER,
      COMMENTER_NAME,
      COMMENTER_ID,
    ]) {
      expect(log).not.toContain(secret);
    }
    for (const text of responses) {
      for (const secret of [verifyToken, appSecret, COMMENT_TEXT, COMMENTER]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  const verify = async (
    query: Record<string, string | undefined> = {},
    { challenge = CHALLENGE, token = verifyToken, mode = 'subscribe' } = {}
  ) => {
    const params = new URLSearchParams();
    const all = {
      'hub.mode': mode,
      'hub.verify_token': token,
      'hub.challenge': challenge,
      ...query,
    };
    for (const [key, value] of Object.entries(all)) {
      if (value !== undefined) {
        params.append(key, value);
      }
    }
    const res = await fetch(`${baseUrl}/ysocial-meta-webhook?${params}`);
    const text = await res.text();
    // The 404 of the demo guard repeats the URL of the caller, the token
    // included, like the not-found handler of Nest. Only to the caller.
    if (res.status !== 404) {
      responses.push(text);
    }
    return {
      status: res.status,
      text,
      type: res.headers.get('content-type') || '',
      json: () => (text ? JSON.parse(text) : undefined),
    };
  };

  const receive = async (
    body: unknown = notification(),
    {
      signature,
      contentType = 'application/json',
      raw,
    }: { signature?: string | null; contentType?: string; raw?: string } = {}
  ) => {
    const text = raw ?? JSON.stringify(body);
    const header = signature === undefined ? sign(text) : signature;
    const res = await fetch(`${baseUrl}/ysocial-meta-webhook`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...(header ? { 'x-hub-signature-256': header } : {}),
      },
      body: text,
    });
    const answer = await res.text();
    responses.push(answer);
    return {
      status: res.status,
      text: answer,
      json: () => (answer ? JSON.parse(answer) : undefined),
    };
  };

  const stored = () => store.list.map((value) => JSON.parse(value));

  describe('without YSOCIAL_DEMO_INTEGRATIONS', () => {
    it.each([undefined, '', '  ,  '])(
      'answers 404 for GET and POST (list %j), also with a valid token and signature',
      async (list) => {
        if (list === undefined) {
          delete process.env[LIST_ENV];
        } else {
          process.env[LIST_ENV] = list;
        }
        const get = await verify();
        expect(get.status).toBe(404);
        expect(get.json().error).toBe('Not Found');
        const post = await receive();
        expect(post.status).toBe(404);
        expect(store.ops).toEqual([]);
      }
    );

    it('answers 404 before 503 when nothing is configured at all', async () => {
      delete process.env[LIST_ENV];
      delete process.env[VERIFY_ENV];
      delete process.env[SECRET_ENV];
      expect((await verify()).status).toBe(404);
      expect((await receive()).status).toBe(404);
    });

    it('answers 404 before 403 and 401 for wrong credentials', async () => {
      delete process.env[LIST_ENV];
      expect((await verify({ 'hub.verify_token': 'wrong' })).status).toBe(404);
      expect(
        (await receive(notification(), { signature: 'sha256=x' })).status
      ).toBe(404);
    });

    it('logs nothing from the webhook guard', async () => {
      delete process.env[LIST_ENV];
      await verify();
      await receive();
      expect(logLines.filter((line) => line.includes('meta webhook'))).toEqual(
        []
      );
    });
  });

  describe('GET (verification request)', () => {
    it('answers 200 with the challenge as plain text', async () => {
      const res = await verify();
      expect(res.status).toBe(200);
      expect(res.text).toBe(CHALLENGE);
      expect(res.type).toMatch(/^text\/plain/);
      expect(logLines).toEqual(['meta webhook verify result=ok']);
      expect(store.ops).toEqual([]);
    });

    it('needs no service token and no actor', async () => {
      // The request of Meta carries neither.
      const res = await fetch(
        `${baseUrl}/ysocial-meta-webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=1`
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('1');
    });

    it('answers 403 for a wrong token', async () => {
      for (const token of [
        randomBytes(32).toString('hex'),
        verifyToken.slice(0, -1),
        `${verifyToken}0`,
        verifyToken.toUpperCase(),
        '',
      ]) {
        const res = await verify({}, { token });
        expect(res.status).toBe(403);
        expect(res.text).not.toContain(CHALLENGE);
      }
    });

    it('answers 403 without a token', async () => {
      const res = await verify({ 'hub.verify_token': undefined });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain(CHALLENGE);
    });

    it('answers 403 for a repeated token parameter', async () => {
      const res = await fetch(
        `${baseUrl}/ysocial-meta-webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.verify_token=${verifyToken}&hub.challenge=${CHALLENGE}`
      );
      expect(res.status).toBe(403);
    });

    it('answers 403 for a wrong or missing mode', async () => {
      for (const mode of ['unsubscribe', 'SUBSCRIBE', '']) {
        expect((await verify({}, { mode })).status).toBe(403);
      }
      expect((await verify({ 'hub.mode': undefined })).status).toBe(403);
    });

    it('answers 403 for a challenge that is not only digits', async () => {
      for (const challenge of [
        'abc',
        '12 3',
        '1;2',
        '<script>alert(1)</script>',
        '-1',
        '1.5',
        '9'.repeat(65),
        '',
      ]) {
        const res = await verify({}, { challenge });
        expect(res.status).toBe(403);
        expect(res.text).not.toContain('script');
      }
      expect((await verify({ 'hub.challenge': undefined })).status).toBe(403);
    });

    it('accepts a challenge of 64 digits', async () => {
      const challenge = '7'.repeat(64);
      const res = await verify({}, { challenge });
      expect(res.status).toBe(200);
      expect(res.text).toBe(challenge);
    });

    it('answers 503 without the token in the environment', async () => {
      delete process.env[VERIFY_ENV];
      const res = await verify();
      expect(res.status).toBe(503);
      expect(res.text).not.toContain(CHALLENGE);
      expect(res.text).toContain(VERIFY_ENV);
      expect(logLines).toEqual([
        'meta webhook verify result=rejected code=not_configured',
      ]);
    });

    it.each(['', '   ', randomBytes(15).toString('hex').slice(0, 31)])(
      'answers 503 for a token that is empty, blank or shorter than 32 characters (%j)',
      async (configured) => {
        process.env[VERIFY_ENV] = configured;
        // Even when the request carries exactly that token.
        const res = await verify({}, { token: configured || 'x' });
        expect(res.status).toBe(503);
        expect(res.text).not.toContain(CHALLENGE);
      }
    );

    it('answers 503 before 403: not configured wins over a wrong request', async () => {
      delete process.env[VERIFY_ENV];
      const res = await verify(
        {},
        { token: 'wrong', mode: 'x', challenge: 'abc' }
      );
      expect(res.status).toBe(503);
    });

    it('logs the rejection with the code and nothing else', async () => {
      await verify({}, { token: 'wrong' });
      await verify({}, { challenge: 'abc' });
      await verify({}, { mode: 'unsubscribe' });
      expect(logLines).toEqual([
        'meta webhook verify result=rejected code=verify_invalid',
        'meta webhook verify result=rejected code=verify_invalid',
        'meta webhook verify result=rejected code=verify_invalid',
      ]);
    });

    it('writes nothing to the store and calls nobody on any answer', async () => {
      await verify();
      await verify({}, { token: 'wrong' });
      delete process.env[VERIFY_ENV];
      await verify();
      expect(store.ops).toEqual([]);
    });
  });

  describe('POST (event notification)', () => {
    it('answers 200 {received:1} for a valid signature and stores the event', async () => {
      const res = await receive();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ received: 1 });
      expect(store.ops).toEqual([
        `rpush ${WEBHOOK_LOG_KEY}`,
        `ltrim ${WEBHOOK_LOG_KEY} -50 -1`,
        `expire ${WEBHOOK_LOG_KEY} 86400`,
      ]);
      expect(stored()).toHaveLength(1);
      expect(stored()[0]).toMatchObject({
        object: 'page',
        entryId: PAGE,
        field: 'feed',
        item: 'comment',
        verb: 'add',
        postId: POST,
        commentId: COMMENT,
      });
      expect(logLines).toEqual([
        'meta webhook object=page events=1 fields=feed result=recorded',
      ]);
    });

    it('stores no comment text and no name of the person', async () => {
      await receive();
      await receive(instagramNotification());
      expect(store.list).toHaveLength(2);
      for (const value of store.list) {
        for (const secret of [
          COMMENT_TEXT,
          COMMENTER,
          COMMENTER_NAME,
          COMMENTER_ID,
        ]) {
          expect(value).not.toContain(secret);
        }
      }
    });

    it('accepts an Instagram notification', async () => {
      const res = await receive(instagramNotification());
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ received: 1 });
      expect(stored()[0]).toMatchObject({
        object: 'instagram',
        field: 'comments',
        commentId: '17950000000000001',
        mediaId: '17900000000000001',
      });
    });

    it('answers 200 {received:0} for a signed payload without events and stores nothing', async () => {
      for (const body of [{}, { object: 'page', entry: [] }, []]) {
        const res = await receive(body);
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({ received: 0 });
      }
      expect(store.ops).toEqual([]);
      expect(logLines.every((line) => line.endsWith('result=ignored'))).toBe(
        true
      );
    });

    it('answers 400 for a signed body that is a JSON string, nothing is stored', async () => {
      const res = await receive('x');
      expect(res.status).toBe(400);
      expect(store.ops).toEqual([]);
    });

    it('answers 200 with the count even when the store fails', async () => {
      store.failing = true;
      const res = await receive();
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ received: 1 });
      expect(logLines).toEqual([
        'meta webhook object=page events=1 fields=feed result=store_failed error=Error',
      ]);
    });

    it('verifies the signature over the raw bytes, not the parsed body', async () => {
      // Same JSON, other bytes: signed with the pretty form, sent compact.
      const body = notification();
      const pretty = JSON.stringify(body, null, 2);
      const compact = JSON.stringify(body);
      expect(
        (await receive(body, { raw: compact, signature: sign(pretty) })).status
      ).toBe(401);
      expect(
        (await receive(body, { raw: pretty, signature: sign(pretty) })).status
      ).toBe(200);
    });

    it('verifies a body with characters outside ASCII', async () => {
      const body = { ...notification(), note: 'Grüße 🌍' };
      expect((await receive(body)).status).toBe(200);
    });

    it('answers 401 for a changed body', async () => {
      const body = JSON.stringify(notification());
      const res = await receive(null, {
        raw: body.replace('add', 'edi'),
        signature: sign(body),
      });
      expect(res.status).toBe(401);
      expect(store.ops).toEqual([]);
    });

    it('answers 401 for a signature of another secret', async () => {
      const text = JSON.stringify(notification());
      const res = await receive(notification(), {
        signature: sign(text, randomBytes(24).toString('hex')),
      });
      expect(res.status).toBe(401);
      expect(logLines).toEqual([
        'meta webhook receive result=rejected code=signature_invalid',
      ]);
    });

    it('answers 401 for a missing, empty or malformed header', async () => {
      const text = JSON.stringify(notification());
      const hex = sign(text).slice('sha256='.length);
      for (const signature of [
        null,
        'sha256=',
        `sha256=${hex.slice(1)}`,
        `sha1=${hex}`,
        hex,
        'sha256=zz',
      ]) {
        const res = await receive(notification(), { signature });
        expect(res.status).toBe(401);
      }
      expect(store.ops).toEqual([]);
      expect(logLines).toEqual(
        Array(6).fill(
          'meta webhook receive result=rejected code=signature_missing'
        )
      );
    });

    it('rejects a signed body that is not JSON and stores nothing', async () => {
      // The body parser answers first (400), whatever the signature says.
      const raw = '{broken';
      const res = await receive(null, { raw, signature: sign(raw) });
      expect(res.status).toBe(400);
      expect(store.ops).toEqual([]);
    });

    it('answers 401 without a raw body: a content type the parser does not read', async () => {
      const raw = JSON.stringify(notification());
      const res = await receive(null, {
        raw,
        contentType: 'text/plain',
        signature: sign(raw),
      });
      expect(res.status).toBe(401);
      expect(store.ops).toEqual([]);
    });

    it('answers 503 without FACEBOOK_APP_SECRET, also with a signature', async () => {
      for (const secret of [undefined, '', '   ']) {
        if (secret === undefined) {
          delete process.env[SECRET_ENV];
        } else {
          process.env[SECRET_ENV] = secret;
        }
        const res = await receive(notification(), {
          signature: sign(JSON.stringify(notification()), secret ?? ''),
        });
        expect(res.status).toBe(503);
        expect(res.text).toContain(SECRET_ENV);
      }
      expect(store.ops).toEqual([]);
      expect(logLines).toEqual(
        Array(3).fill(
          'meta webhook receive result=rejected code=not_configured'
        )
      );
    });

    it('answers 503 before 401: not configured wins over a missing signature', async () => {
      delete process.env[SECRET_ENV];
      expect((await receive(notification(), { signature: null })).status).toBe(
        503
      );
    });

    it('does not use the verify token as secret', async () => {
      const text = JSON.stringify(notification());
      const res = await receive(notification(), {
        signature: sign(text, verifyToken),
      });
      expect(res.status).toBe(401);
    });

    it('needs the verify token for GET only and the secret for POST only', async () => {
      delete process.env[VERIFY_ENV];
      expect((await receive()).status).toBe(200);
      process.env[VERIFY_ENV] = verifyToken;
      delete process.env[SECRET_ENV];
      expect((await verify()).status).toBe(200);
    });

    it('keeps the latest events in order across notifications', async () => {
      await receive(notification(`${POST}_300000000000001`));
      await receive(notification(`${POST}_300000000000002`));
      expect(stored().map((event) => event.commentId)).toEqual([
        `${POST}_300000000000001`,
        `${POST}_300000000000002`,
      ]);
    });

    it('writes nothing for any rejection and calls nobody', async () => {
      await receive(notification(), { signature: null });
      await receive(notification(), { signature: `sha256=${'0'.repeat(64)}` });
      delete process.env[SECRET_ENV];
      await receive();
      expect(store.ops).toEqual([]);
    });
  });

  describe('methods the receiver does not offer', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])(
      'answers 404 for %s',
      async (method) => {
        const res = await fetch(`${baseUrl}/ysocial-meta-webhook`, {
          method,
          headers: { 'x-hub-signature-256': sign('{}') },
          body: '{}',
        });
        expect(res.status).toBe(404);
        expect(store.ops).toEqual([]);
      }
    );

    // Express answers HEAD with the GET handler, so it passes the verify
    // branch of the guard like a GET.
    it('treats HEAD like the verification request', async () => {
      const query = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': verifyToken,
        'hub.challenge': CHALLENGE,
      });
      const ok = await fetch(`${baseUrl}/ysocial-meta-webhook?${query}`, {
        method: 'HEAD',
      });
      expect(ok.status).toBe(200);
      query.set('hub.verify_token', 'falsch');
      const wrong = await fetch(`${baseUrl}/ysocial-meta-webhook?${query}`, {
        method: 'HEAD',
      });
      expect(wrong.status).toBe(403);
      expect(store.ops).toEqual([]);
    });
  });

  // Express routes these variants to the receiver as well. The exception
  // from the Basic Auth of the reverse proxy covers only the exact path
  // (README), so they stay behind it. The guards hold here as well.
  describe('variants of the path', () => {
    it.each(['/YSOCIAL-META-WEBHOOK', '/ysocial-meta-webhook/'])(
      'reaches the guards for %s',
      async (path) => {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
          },
          body: '{}',
        });
        expect(res.status).toBe(401);
        expect(store.ops).toEqual([]);
      }
    );
  });
});
