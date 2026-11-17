import { Logger } from '@nestjs/common';
import {
  WEBHOOK_LOG_KEY,
  WEBHOOK_LOG_LIMIT,
  WEBHOOK_LOG_TTL_S,
} from './webhook.rules';
import {
  YsocialMetaWebhookService,
  YsocialWebhookLogStore,
} from './ysocial.meta.webhook.service';

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
  constructor(store: YsocialWebhookLogStore) {
    super();
    this.store = store;
  }
}

describe('YsocialMetaWebhookService', () => {
  let store: FakeStore;
  let service: StoreService;
  let lines: string[];
  let spies: jest.SpyInstance[];
  const now = new Date('2026-11-17T12:00:00.000Z');

  beforeEach(() => {
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
        'meta webhook object=page events=3 fields=feed,comments result=recorded',
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
        'meta webhook object=page events=2 fields=feed result=store_failed error=ReplyError',
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
          'meta webhook object=page events=1 fields=feed result=store_failed error=Error',
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
      expect(lines.map((line) => line.split('error=')[1])).toEqual([
        'Error',
        'Error',
      ]);
    });

    it('does not use the real Redis when no store is injected', () => {
      // The default store is the shared ioRedis of Postiz, the constructor
      // must not open anything by itself.
      expect(() => new YsocialMetaWebhookService()).not.toThrow();
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
  });
});
