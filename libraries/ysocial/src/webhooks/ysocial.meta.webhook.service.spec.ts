import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { INBOX_WEBHOOK_BELLS_MAX, INBOX_WEBHOOK_ID_MAX } from './webhook.rules';
import { YsocialWebhookRepository } from '../database/ysocial.webhook.repository';
import {
  WEBHOOK_LOG_KEY,
  WEBHOOK_LOG_LIMIT,
  WEBHOOK_LOG_TTL_S,
} from './webhook.rules';
import {
  BELL_TIMEOUT_MS,
  YsocialMetaWebhookService,
  YsocialWebhookLogStore,
} from './ysocial.meta.webhook.service';

const SWITCH_ENV = 'YSOCIAL_INBOX_EVENTS';
const LIST_ENV = 'YSOCIAL_DEMO_INTEGRATIONS';
const HUB_ENVS = ['HUB_INTERNAL_URL', 'HUB_INTERNAL_TOKEN'];
const ENVS = [SWITCH_ENV, LIST_ENV, ...HUB_ENVS];
const hubToken = randomBytes(32).toString('hex');

const PAGE = '100000000000001';
const POST = `${PAGE}_200000000000001`;
const TEXT = 'Erfundener Kommentartext';
const NAME = 'Erfundene Person';
const PERSON_ID = '500000000000777';
const SECRET_IN_ERROR = 'Erfundene Fehlermeldung mit Zugangsdaten';

const change = (commentId: string, field = 'feed') => ({
  field,
  value: {
    item: 'comment',
    verb: 'add',
    post_id: POST,
    comment_id: commentId,
    message: TEXT,
    from: { name: NAME, id: PERSON_ID },
  },
});
const payload = (...changes: unknown[]) => ({
  object: 'page',
  entry: [{ id: PAGE, time: 1_795_000_100, changes }],
});

class FakeStore implements YsocialWebhookLogStore {
  calls: string[] = [];
  list: string[] = [];
  rpush = jest.fn(async (key: string, value: string) => {
    this.calls.push(`rpush ${key}`);
    this.list.push(value);
    return this.list.length;
  });
  ltrim = jest.fn(async (key: string, start: number, stop: number) => {
    this.calls.push(`ltrim ${key} ${start} ${stop}`);
    return 'OK';
  });
  expire = jest.fn(async (key: string, seconds: number) => {
    this.calls.push(`expire ${key} ${seconds}`);
    return 1;
  });
  lrange = jest.fn(async (_key: string, _start: number, _stop: number) => [
    ...this.list,
  ]);
}

class StoreService extends YsocialMetaWebhookService {
  constructor(
    store: YsocialWebhookLogStore,
    channels: YsocialWebhookRepository = {} as YsocialWebhookRepository
  ) {
    super(channels);
    this.store = store;
  }
}

describe('YsocialMetaWebhookService', () => {
  let store: FakeStore;
  let service: StoreService;
  let lines: string[];
  let spies: jest.SpyInstance[];
  const now = new Date('2026-11-17T12:00:00.000Z');
  const savedEnv = ENVS.map((name) => process.env[name]);

  beforeEach(() => {
    // The demo list is set, the switch for the bells is not.
    process.env[LIST_ENV] = 'int-demo-fb-1';
    delete process.env[SWITCH_ENV];
    store = new FakeStore();
    service = new StoreService(store);
    lines = [];
    spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args) => {
        lines.push(args.map(String).join(' '));
      })
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    ENVS.forEach((name, i) => {
      if (savedEnv[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[i];
      }
    });
    // Privacy, in every case: nothing of the notification except ids.
    const log = lines.join('\n');
    for (const secret of [TEXT, NAME, PERSON_ID, SECRET_IN_ERROR]) {
      expect(log).not.toContain(secret);
    }
  });

  describe('record', () => {
    it('stores one entry per event, then trims, then sets the TTL', async () => {
      const result = await service.record(
        payload(change('11'), change('12'), change('13', 'comments')),
        now
      );
      expect(result).toEqual({ received: 3 });
      expect(store.calls).toEqual([
        `rpush ${WEBHOOK_LOG_KEY}`,
        `rpush ${WEBHOOK_LOG_KEY}`,
        `rpush ${WEBHOOK_LOG_KEY}`,
        `ltrim ${WEBHOOK_LOG_KEY} -50 -1`,
        `expire ${WEBHOOK_LOG_KEY} 86400`,
      ]);
      expect(WEBHOOK_LOG_KEY).toBe('ysocial:demo:meta-webhook-events');
      expect(WEBHOOK_LOG_LIMIT).toBe(50);
      expect(WEBHOOK_LOG_TTL_S).toBe(86400);
    });

    it('stores the reduced event as JSON, in the order of the notification', async () => {
      await service.record(payload(change('11'), change('12')), now);
      const stored = store.list.map((value) => JSON.parse(value));
      expect(stored.map((event) => event.commentId)).toEqual(['11', '12']);
      expect(stored[0]).toMatchObject({
        receivedAt: now.toISOString(),
        object: 'page',
        entryId: PAGE,
        field: 'feed',
        item: 'comment',
        verb: 'add',
        postId: POST,
      });
      for (const value of store.list) {
        for (const secret of [TEXT, NAME, PERSON_ID]) {
          expect(value).not.toContain(secret);
        }
      }
    });

    it('stamps the events with the time of the call by default', async () => {
      const before = Date.now();
      await service.record(payload(change('11')));
      const stored = JSON.parse(store.list[0]);
      expect(Date.parse(stored.receivedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(stored.receivedAt)).toBeLessThanOrEqual(Date.now());
    });

    it('logs ids-free counts, the object and the fields', async () => {
      await service.record(
        payload(change('11'), change('12'), change('13', 'comments')),
        now
      );
      expect(lines).toEqual([
        'meta webhook object=page events=3 fields=feed,comments result=recorded bells=0',
      ]);
    });

    it('answers received 0 and logs ignored without events', async () => {
      for (const body of [
        {},
        null,
        'x',
        payload(),
        payload({ field: 'Bad Field' }),
        {
          object: 'page',
          entry: [{ id: PAGE, messaging: [{ message: { text: TEXT } }] }],
        },
      ]) {
        lines.length = 0;
        expect(await service.record(body, now)).toEqual({ received: 0 });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^meta webhook object=(page|-) events=0 fields=- result=ignored$/
        );
      }
      expect(store.rpush).not.toHaveBeenCalled();
      expect(store.ltrim).not.toHaveBeenCalled();
      expect(store.expire).not.toHaveBeenCalled();
    });

    it('answers 200-shaped received:n and logs store_failed with the class name when the store fails', async () => {
      class RedisDown extends Error {
        name = 'ReplyError';
      }
      store.rpush.mockRejectedValue(new RedisDown(SECRET_IN_ERROR));
      const result = await service.record(
        payload(change('11'), change('12')),
        now
      );
      expect(result).toEqual({ received: 2 });
      expect(lines).toEqual([
        'meta webhook object=page events=2 fields=feed result=store_failed error=ReplyError bells=0',
      ]);
      expect(store.ltrim).not.toHaveBeenCalled();
      expect(store.expire).not.toHaveBeenCalled();
    });

    it.each(['ltrim', 'expire'] as const)(
      'also survives a failing %s',
      async (step) => {
        store[step].mockRejectedValue(new Error(SECRET_IN_ERROR));
        expect(await service.record(payload(change('11')), now)).toEqual({
          received: 1,
        });
        expect(lines).toEqual([
          'meta webhook object=page events=1 fields=feed result=store_failed error=Error bells=0',
        ]);
      }
    );

    it('logs Error for a thrown value that is not an Error or has an odd name', async () => {
      store.rpush.mockRejectedValueOnce(SECRET_IN_ERROR);
      await service.record(payload(change('11')), now);
      const odd = new Error(SECRET_IN_ERROR);
      odd.name = `x ${SECRET_IN_ERROR}`;
      store.rpush.mockRejectedValueOnce(odd);
      await service.record(payload(change('11')), now);
      expect(
        lines.map((line) => line.split('error=')[1].split(' ')[0])
      ).toEqual(['Error', 'Error']);
    });

    it('does not use the real Redis when no store is injected', () => {
      // The default store is the shared ioRedis of Postiz, the constructor
      // must not open anything by itself.
      expect(
        () =>
          new YsocialMetaWebhookService(
            {} as unknown as YsocialWebhookRepository
          )
      ).not.toThrow();
    });

    it.each([undefined, '', '  ,  ', ' , '])(
      'writes nothing to the store without the demo list (%j) and logs not_logged',
      async (list) => {
        if (list === undefined) {
          delete process.env[LIST_ENV];
        } else {
          process.env[LIST_ENV] = list;
        }
        const result = await service.record(payload(change('11')), now);
        expect(result).toEqual({ received: 1 });
        expect(store.rpush).not.toHaveBeenCalled();
        expect(store.ltrim).not.toHaveBeenCalled();
        expect(store.expire).not.toHaveBeenCalled();
        expect(lines).toEqual([
          'meta webhook object=page events=1 fields=feed result=not_logged bells=0',
        ]);
      }
    );
  });

  // Phase 3, PR 74: the bell inbox.webhook to the hub. The platform and the
  // hub are never called for real: global fetch is replaced, the repository
  // is a stand-in.
  describe('bells (YSOCIAL_INBOX_EVENTS=true)', () => {
    const realFetch = global.fetch;
    const HUB_URL = 'http://hub.test';
    const ACCOUNT = '17840000000000001';
    const IG_COMMENT = '17950000000000001';
    const SENT_MS = 1_795_000_100_000;
    const channel = (
      id: string,
      org = 'org-1',
      customerId: string | null = null
    ) => ({
      id,
      organizationId: org,
      customerId,
      providerIdentifier: 'facebook',
    });
    const instagram = (...changes: unknown[]) => ({
      object: 'instagram',
      entry: [{ id: ACCOUNT, time: 1_795_000_100, changes }],
    });
    const igChange = {
      field: 'comments',
      value: {
        id: IG_COMMENT,
        text: TEXT,
        from: { id: PERSON_ID, username: NAME },
        media: { id: '17900000000000001' },
      },
    };
    const DATA_KEYS = [
      'object',
      'entryId',
      'field',
      'item',
      'verb',
      'postId',
      'commentId',
      'parentId',
      'mediaId',
      'createdAt',
      'sentAt',
      'receivedAt',
    ];

    let channels: { getChannelsForWebhook: jest.Mock };
    let fetchMock: jest.Mock;
    let bellService: StoreService;

    const sent = () =>
      fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        headers: init.headers as Record<string, string>,
        raw: String(init.body),
        body: JSON.parse(String(init.body)),
      }));

    beforeEach(() => {
      process.env[SWITCH_ENV] = 'true';
      process.env.HUB_INTERNAL_URL = HUB_URL;
      process.env.HUB_INTERNAL_TOKEN = hubToken;
      channels = {
        getChannelsForWebhook: jest.fn(async () => [channel('int-1')]),
      };
      fetchMock = jest.fn(async () => ({ status: 202 }));
      global.fetch = fetchMock as unknown as typeof fetch;
      bellService = new StoreService(
        store,
        channels as unknown as YsocialWebhookRepository
      );
    });

    afterEach(() => {
      global.fetch = realFetch;
      jest.restoreAllMocks();
      // The bell never carries the token of the hub into a log line.
      expect(lines.join('\n')).not.toContain(hubToken);
    });

    it('rings one bell per channel for a Facebook comment, with ids only', async () => {
      const result = await bellService.record(payload(change('11')), now);
      expect(result).toEqual({ received: 1 });
      expect(channels.getChannelsForWebhook).toHaveBeenCalledTimes(1);
      expect(channels.getChannelsForWebhook).toHaveBeenCalledWith(
        'facebook',
        PAGE
      );
      const [call, ...rest] = sent();
      expect(rest).toEqual([]);
      expect(call.url).toBe(`${HUB_URL}/api/internal/events`);
      expect(call.headers.authorization).toBe(`Bearer ${hubToken}`);
      expect(call.headers['idempotency-key']).toBe(call.body.id);
      expect(call.body).toMatchObject({
        id: `inbox.webhook:int-1:11.add.${SENT_MS}`,
        kind: 'inbox.webhook',
        source: 'postiz',
        occurredAt: new Date(SENT_MS).toISOString(),
        subject: { type: 'channel', id: 'int-1' },
        postiz: {
          organizationId: 'org-1',
          integrationId: 'int-1',
          customerId: null,
          providerIdentifier: 'facebook',
        },
      });
      expect(Object.keys(call.body.data).sort()).toEqual([...DATA_KEYS].sort());
      expect(call.body.data).toMatchObject({
        object: 'page',
        entryId: PAGE,
        field: 'feed',
        item: 'comment',
        verb: 'add',
        postId: POST,
        commentId: '11',
        receivedAt: now.toISOString(),
      });
      expect(call.body).not.toHaveProperty('reason');
      for (const secret of [TEXT, NAME, PERSON_ID]) {
        expect(call.raw).not.toContain(secret);
      }
      expect(call.raw).not.toMatch(/"(message|text|from|name|username)"/);
      expect(lines).toEqual([
        'meta webhook object=page events=1 fields=feed result=recorded bells=1 delivered=1 failed=0 unknown_channel=0 dropped=0',
      ]);
    });

    it('rings the bell for an Instagram comment with the account as entry', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([
        { ...channel('int-ig'), providerIdentifier: 'instagram' },
      ]);
      await bellService.record(instagram(igChange), now);
      expect(channels.getChannelsForWebhook).toHaveBeenCalledWith(
        'instagram',
        ACCOUNT
      );
      const [call, ...rest] = sent();
      expect(rest).toEqual([]);
      expect(call.body.id).toBe(
        `inbox.webhook:int-ig:${IG_COMMENT}.comments.${SENT_MS}`
      );
      expect(call.headers['idempotency-key']).toBe(call.body.id);
      expect(call.body.postiz.providerIdentifier).toBe('instagram');
      expect(Object.keys(call.body.data).sort()).toEqual([...DATA_KEYS].sort());
      expect(call.body.data).toMatchObject({
        object: 'instagram',
        entryId: ACCOUNT,
        field: 'comments',
        item: null,
        verb: null,
        commentId: IG_COMMENT,
        mediaId: '17900000000000001',
      });
      for (const secret of [TEXT, NAME, PERSON_ID]) {
        expect(call.raw).not.toContain(secret);
      }
      expect(call.raw).not.toMatch(/"(message|text|from|name|username)"/);
    });

    it('rings the bell for every verb of a feed comment', async () => {
      const edited = change('12');
      edited.value.verb = 'edited';
      await bellService.record(payload(edited), now);
      expect(sent().map((call) => call.body.id)).toEqual([
        `inbox.webhook:int-1:12.edited.${SENT_MS}`,
      ]);
    });

    it('carries the customer of the channel', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([
        channel('int-1', 'org-1', 'cust-1'),
      ]);
      await bellService.record(payload(change('11')), now);
      expect(sent()[0].body.postiz.customerId).toBe('cust-1');
    });

    it('rings one bell for each channel of the Page, also across organizations', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([
        channel('int-1', 'org-1'),
        channel('int-2', 'org-2'),
      ]);
      await bellService.record(payload(change('11')), now);
      const calls = sent();
      expect(calls.map((call) => call.body.subject.id).sort()).toEqual([
        'int-1',
        'int-2',
      ]);
      expect(
        calls.map((call) => call.body.postiz.organizationId).sort()
      ).toEqual(['org-1', 'org-2']);
      expect(new Set(calls.map((call) => call.body.id)).size).toBe(2);
      expect(lines[0]).toContain('bells=2 delivered=2 failed=0');
    });

    it('sends the bells side by side, not one after the other', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([
        channel('int-1'),
        channel('int-2'),
      ]);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async () => {
        await gate;
        return { status: 202 };
      });
      const done = bellService.record(payload(change('11')), now);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      release();
      await done;
    });

    it('gives every bell one attempt with a timeout of 5 seconds', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      await bellService.record(payload(change('11')), now);
      expect(BELL_TIMEOUT_MS).toBe(5000);
      expect(timeout).toHaveBeenCalledWith(BELL_TIMEOUT_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rings once for two equal changes in one notification and reads the channels once', async () => {
      const result = await bellService.record(
        payload(change('11'), change('11'), change('12')),
        now
      );
      expect(result).toEqual({ received: 3 });
      expect(
        sent()
          .map((call) => call.body.id)
          .sort()
      ).toEqual([
        `inbox.webhook:int-1:11.add.${SENT_MS}`,
        `inbox.webhook:int-1:12.add.${SENT_MS}`,
      ]);
      expect(channels.getChannelsForWebhook).toHaveBeenCalledTimes(1);
      expect(lines[0]).toContain('events=3');
      expect(lines[0]).toContain('bells=2 delivered=2');
    });

    it('rings at most 50 bells per notification and logs the rest as dropped', async () => {
      expect(INBOX_WEBHOOK_BELLS_MAX).toBe(50);
      const changes = Array.from({ length: 60 }, (_, i) =>
        change(String(1000 + i))
      );
      const result = await bellService.record(payload(...changes), now);
      expect(result).toEqual({ received: 60 });
      expect(fetchMock).toHaveBeenCalledTimes(50);
      // The first 50 in the order of the notification.
      expect(sent()[0].body.id).toBe(`inbox.webhook:int-1:1000.add.${SENT_MS}`);
      expect(sent()[49].body.id).toBe(
        `inbox.webhook:int-1:1049.add.${SENT_MS}`
      );
      expect(lines).toEqual([
        'meta webhook object=page events=60 fields=feed result=recorded bells=50 delivered=50 failed=0 unknown_channel=0 dropped=10',
      ]);
    });

    it('does not count equal changes towards the limit of 50', async () => {
      const changes = Array.from({ length: 60 }, () => change('1000'));
      await bellService.record(payload(...changes), now);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lines[0]).toContain('bells=1 delivered=1 failed=0');
      expect(lines[0]).toMatch(/dropped=0$/);
    });

    it('counts exactly 50 bells as none dropped', async () => {
      const changes = Array.from({ length: 50 }, (_, i) =>
        change(String(1000 + i))
      );
      await bellService.record(payload(...changes), now);
      expect(fetchMock).toHaveBeenCalledTimes(50);
      expect(lines[0]).toMatch(/bells=50 delivered=50 failed=0 .* dropped=0$/);
    });

    it('rings a new bell for a second edit of a comment at another time', async () => {
      const later = {
        object: 'page',
        entry: [
          {
            id: PAGE,
            time: 1_795_000_200,
            changes: [change('11')],
          },
        ],
      };
      await bellService.record(payload(change('11')), now);
      await bellService.record(later, now);
      const ids = sent().map((call) => call.body.id);
      expect(new Set(ids).size).toBe(2);
    });

    it.each([
      ['a reaction', { item: 'reaction', verb: 'add' }],
      ['a post', { item: 'status', verb: 'add' }],
      ['a photo', { item: 'photo', verb: 'add' }],
      ['an event without item', {}],
    ])('does not ring for %s on the feed', async (_name, value) => {
      const body = payload({
        field: 'feed',
        value: { ...value, post_id: POST, message: TEXT },
      });
      expect(await bellService.record(body, now)).toEqual({ received: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
      expect(lines[0]).toMatch(/ bells=0$/);
    });

    it('does not ring for a Page field other than feed, nor for an Instagram field other than comments', async () => {
      await bellService.record(
        payload({ field: 'ratings', value: { item: 'comment', verb: 'add' } }),
        now
      );
      await bellService.record(
        instagram({ field: 'mentions', value: { media_id: '1' } }),
        now
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
    });

    it('does not ring for a user object, which is not even an event', async () => {
      const body = {
        object: 'user',
        entry: [
          {
            id: PERSON_ID,
            time: 1_795_000_100,
            changes: [{ field: 'feed', value: { item: 'comment' } }],
          },
        ],
      };
      expect(await bellService.record(body, now)).toEqual({ received: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
      expect(lines).toEqual([
        'meta webhook object=- events=0 fields=- result=ignored',
      ]);
    });

    it('rings only for the comments of a mixed notification', async () => {
      const reaction = {
        field: 'feed',
        value: { item: 'reaction', verb: 'add', post_id: POST },
      };
      await bellService.record(payload(reaction, change('11')), now);
      expect(sent().map((call) => call.body.id)).toEqual([
        `inbox.webhook:int-1:11.add.${SENT_MS}`,
      ]);
    });

    it('counts a comment of an unknown channel and calls nobody', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([]);
      const result = await bellService.record(payload(change('11')), now);
      expect(result).toEqual({ received: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines).toEqual([
        'meta webhook object=page events=1 fields=feed result=recorded bells=0 delivered=0 failed=0 unknown_channel=1 dropped=0',
      ]);
    });

    it('counts a comment without a Page id as unknown and does not ask the repository', async () => {
      const body = {
        object: 'page',
        entry: [{ time: 1_795_000_100, changes: [change('11')] }],
      };
      await bellService.record(body, now);
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines[0]).toContain('unknown_channel=1');
    });

    it('rings no bell for an event without a comment, post or media id', async () => {
      const bare = {
        field: 'feed',
        value: { item: 'comment', verb: 'add' },
      };
      await bellService.record(payload(bare), now);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines[0]).toContain('bells=0 delivered=0 failed=0');
    });

    it('rings no bell for an id longer than 300 characters, and one for exactly 300', async () => {
      expect(INBOX_WEBHOOK_ID_MAX).toBe(300);
      // inbox.webhook:<channel>:11.add.1795000100000 is 35 characters plus the channel.
      const prefix = `inbox.webhook::11.add.${SENT_MS}`.length;
      const exact = 'c'.repeat(300 - prefix);
      channels.getChannelsForWebhook.mockResolvedValue([channel(exact)]);
      await bellService.record(payload(change('11')), now);
      expect(sent()).toHaveLength(1);
      expect(sent()[0].body.id).toHaveLength(300);

      fetchMock.mockClear();
      lines.length = 0;
      channels.getChannelsForWebhook.mockResolvedValue([channel(`${exact}c`)]);
      await bellService.record(payload(change('11')), now);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines).toEqual([
        'meta webhook object=page events=1 fields=feed result=recorded bells=0 delivered=0 failed=0 unknown_channel=0 dropped=0',
      ]);
    });

    it('rings no bell for a channel id the hub would refuse (blank in the id)', async () => {
      channels.getChannelsForWebhook.mockResolvedValue([channel('int 1')]);
      expect(await bellService.record(payload(change('11')), now)).toEqual({
        received: 1,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines[0]).toContain('bells=0 delivered=0');
    });

    it.each([undefined, 'false', 'TRUE', '1', 'True', ' true', ''])(
      'does not ring, read channels or call the hub with YSOCIAL_INBOX_EVENTS=%j',
      async (value) => {
        if (value === undefined) {
          delete process.env[SWITCH_ENV];
        } else {
          process.env[SWITCH_ENV] = value;
        }
        const result = await bellService.record(payload(change('11')), now);
        expect(result).toEqual({ received: 1 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
        expect(lines).toEqual([
          'meta webhook object=page events=1 fields=feed result=recorded bells=0',
        ]);
      }
    );

    it('logs bells=not_configured and calls nobody when the hub is not configured', async () => {
      for (const [name, value] of [
        ['HUB_INTERNAL_URL', undefined],
        ['HUB_INTERNAL_URL', 'not a url'],
        ['HUB_INTERNAL_TOKEN', undefined],
        ['HUB_INTERNAL_TOKEN', 'short-secret'],
        ['HUB_INTERNAL_TOKEN', ''],
      ] as const) {
        process.env.HUB_INTERNAL_URL = HUB_URL;
        process.env.HUB_INTERNAL_TOKEN = hubToken;
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
        lines.length = 0;
        const result = await bellService.record(payload(change('11')), now);
        expect(result).toEqual({ received: 1 });
        expect(lines).toEqual([
          'meta webhook object=page events=1 fields=feed result=recorded bells=not_configured',
        ]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
    });

    describe('when the hub does not answer', () => {
      const expectOneFailedAttempt = async () => {
        const result = await bellService.record(payload(change('11')), now);
        expect(result).toEqual({ received: 1 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lines).toEqual([
          'meta webhook object=page events=1 fields=feed result=recorded bells=1 delivered=0 failed=1 unknown_channel=0 dropped=0',
        ]);
      };

      it('survives a hub that is not reachable', async () => {
        fetchMock.mockRejectedValue(new TypeError(SECRET_IN_ERROR));
        await expectOneFailedAttempt();
      });

      it('survives a hub that runs out of time', async () => {
        const timeout = new Error(SECRET_IN_ERROR);
        timeout.name = 'TimeoutError';
        fetchMock.mockRejectedValue(timeout);
        await expectOneFailedAttempt();
      });

      it.each([500, 502, 401, 422])(
        'survives an answer %s and does not try again',
        async (status) => {
          fetchMock.mockResolvedValue({ status });
          await expectOneFailedAttempt();
        }
      );

      it('counts a duplicate (409) as delivered', async () => {
        fetchMock.mockResolvedValue({ status: 409 });
        await bellService.record(payload(change('11')), now);
        expect(lines[0]).toContain('bells=1 delivered=1 failed=0');
      });

      it('counts the failed bell of one channel and delivers the other', async () => {
        channels.getChannelsForWebhook.mockResolvedValue([
          channel('int-1'),
          channel('int-2'),
        ]);
        fetchMock.mockImplementation(async (_url: string, init: any) =>
          JSON.parse(init.body).subject.id === 'int-1'
            ? { status: 500 }
            : { status: 202 }
        );
        await bellService.record(payload(change('11')), now);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(lines[0]).toContain('bells=2 delivered=1 failed=1');
      });
    });

    it('logs bells=failed with the class name when the repository throws, and still answers', async () => {
      class DatabaseDown extends Error {
        name = 'PrismaClientInitializationError';
      }
      channels.getChannelsForWebhook.mockRejectedValue(
        new DatabaseDown(SECRET_IN_ERROR)
      );
      const result = await bellService.record(payload(change('11')), now);
      expect(result).toEqual({ received: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines).toEqual([
        'meta webhook object=page events=1 fields=feed result=recorded bells=failed error=PrismaClientInitializationError',
      ]);
    });

    it('logs the demo log and the bells side by side with the demo list', async () => {
      await bellService.record(payload(change('11')), now);
      expect(store.list).toHaveLength(1);
      expect(sent()).toHaveLength(1);
      expect(lines[0]).toContain('result=recorded bells=1 delivered=1');
    });

    it('does not write to Redis without the demo list, but rings', async () => {
      delete process.env[LIST_ENV];
      await bellService.record(payload(change('11')), now);
      expect(store.rpush).not.toHaveBeenCalled();
      expect(store.ltrim).not.toHaveBeenCalled();
      expect(store.expire).not.toHaveBeenCalled();
      expect(sent()).toHaveLength(1);
      expect(lines).toEqual([
        'meta webhook object=page events=1 fields=feed result=not_logged bells=1 delivered=1 failed=0 unknown_channel=0 dropped=0',
      ]);
    });

    it('rings although the demo log fails', async () => {
      store.rpush.mockRejectedValue(new Error(SECRET_IN_ERROR));
      await bellService.record(payload(change('11')), now);
      expect(sent()).toHaveLength(1);
      expect(lines[0]).toContain('result=store_failed error=Error bells=1');
    });

    it('does not ring when the log of events is read', async () => {
      await bellService.events();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channels.getChannelsForWebhook).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('reads the whole window and answers newest first', async () => {
      await service.record(payload(change('11'), change('12')), now);
      await service.record(payload(change('13')), now);
      const result = await service.events();
      expect(store.lrange).toHaveBeenCalledWith(WEBHOOK_LOG_KEY, -50, -1);
      expect(result.events.map((event: any) => event.commentId)).toEqual([
        '13',
        '12',
        '11',
      ]);
      expect(result.limit).toBe(50);
      expect(result.ttlSeconds).toBe(86400);
    });

    it('leaves out an entry that is not valid JSON', async () => {
      store.list = [
        JSON.stringify({ commentId: '1' }),
        '{not json',
        '',
        JSON.stringify({ commentId: '2' }),
      ];
      const result = await service.events();
      expect(result.events).toEqual([{ commentId: '2' }, { commentId: '1' }]);
    });

    it('answers an empty list when nothing is stored or the store answers nothing', async () => {
      expect((await service.events()).events).toEqual([]);
      store.lrange.mockResolvedValue(undefined as unknown as string[]);
      expect((await service.events()).events).toEqual([]);
    });

    it('does not log anything', async () => {
      store.list = [JSON.stringify({ commentId: '1' })];
      await service.events();
      expect(lines).toEqual([]);
    });

    it('answers 503 store_unavailable without Redis and logs the class name only', async () => {
      store.lrange.mockRejectedValue(
        new Error(`connect ECONNREFUSED ${SECRET_IN_ERROR}`)
      );
      await expect(service.events()).rejects.toMatchObject({
        status: 503,
        response: { statusCode: 503, code: 'store_unavailable' },
      });
      expect(lines).toEqual([
        'meta webhook events result=rejected code=store_unavailable error=Error',
      ]);
    });
  });
});
