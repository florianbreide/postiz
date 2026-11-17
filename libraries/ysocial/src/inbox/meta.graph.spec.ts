import { randomBytes } from 'crypto';
import { InboxPlatformError, InboxUsageMeter } from './inbox.rules';
import {
  afterCursor,
  beforePostWindow,
  hasMore,
  inPostWindow,
  isUnknownObject,
  metaGraph,
  newSince,
  timeOf,
} from './meta.graph';

const accessToken = randomBytes(24).toString('hex');
const REASON = 'Die Plattform hat keine lesbare Antwort geschickt.';

const answer = (text: string | null, status = 200) =>
  new Response(text, { status });

// Fails with the error, the way a caller sees it.
const failure = async (): Promise<InboxPlatformError> => {
  try {
    await metaGraph('POST', accessToken, '123', {});
  } catch (err) {
    expect(err).toBeInstanceOf(InboxPlatformError);
    return err as InboxPlatformError;
  }
  throw new Error('metaGraph did not throw');
};

describe('metaGraph', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = original;
  });

  describe('2xx without a readable answer', () => {
    it.each([
      ['an empty body with 200', () => answer('')],
      ['a 204', () => answer(null, 204)],
      ['HTML', () => answer('<html><body>Erfunden</body></html>')],
      ['a body cut off mid-way', () => answer('{"success": tr')],
      ['the bare value true', () => answer('true')],
      ['null', () => answer('null')],
      ['a number', () => answer('42')],
      ['a string', () => answer('"ok"')],
      ['an array', () => answer('[{"id": "1"}]')],
      [
        'a json() that throws',
        () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected end of JSON input');
            },
          } as unknown as Response),
      ],
    ])('throws unreadable for %s', async (_name, make) => {
      fetchMock.mockResolvedValue(make());
      const err = await failure();
      expect(err.details).toEqual({
        unavailable: false,
        unreadable: true,
        status: expect.any(Number),
        reason: REASON,
      });
      expect(err.message).toMatch(/ unreadable$/);
    });

    it('keeps the status of the answer', async () => {
      fetchMock.mockResolvedValue(answer(null, 204));
      expect((await failure()).details.status).toBe(204);
      fetchMock.mockResolvedValue(answer('', 200));
      expect((await failure()).details.status).toBe(200);
    });

    it.each(['GET', 'POST', 'DELETE'] as const)(
      'throws unreadable for %s as well',
      async (method) => {
        fetchMock.mockResolvedValue(answer(''));
        await expect(
          metaGraph(method, accessToken, '123', {})
        ).rejects.toMatchObject({ details: { unreadable: true } });
      }
    );
  });

  describe('the 15 s run out while the body comes in', () => {
    const slowBody = (name: string, status = 200) =>
      ({
        ok: status < 400,
        status,
        json: async () => {
          throw new DOMException('The operation timed out.', name);
        },
      } as unknown as Response);

    it.each(['TimeoutError', 'AbortError'])(
      'counts a 2xx as no answer at all for %s, like a timeout before the headers',
      async (name) => {
        fetchMock.mockResolvedValue(slowBody(name));
        const err = await failure();
        expect(err.details).toEqual({ unavailable: true });
        expect(err.message).toBe('platform unavailable');
      }
    );

    it('keeps the status of a 4xx, Meta has already refused', async () => {
      fetchMock.mockResolvedValue(slowBody('TimeoutError', 400));
      const err = await failure();
      expect(err.details).toMatchObject({ unavailable: false, status: 400 });
      expect(err.details.unreadable).toBeUndefined();
    });
  });

  describe('readable answers', () => {
    it('returns a JSON object', async () => {
      fetchMock.mockResolvedValue(answer('{"id": "123", "success": true}'));
      await expect(metaGraph('POST', accessToken, '123', {})).resolves.toEqual({
        id: '123',
        success: true,
      });
    });

    it('returns an empty JSON object, it is readable', async () => {
      fetchMock.mockResolvedValue(answer('{}'));
      await expect(metaGraph('POST', accessToken, '123', {})).resolves.toEqual(
        {}
      );
    });

    it('returns {"success": false} untouched, the caller decides', async () => {
      fetchMock.mockResolvedValue(answer('{"success": false}'));
      await expect(metaGraph('POST', accessToken, '123', {})).resolves.toEqual({
        success: false,
      });
    });
  });

  describe('errors that stay as they were', () => {
    it('throws the error of Meta for an error object with 200, without unreadable', async () => {
      fetchMock.mockResolvedValue(
        answer(
          JSON.stringify({
            error: {
              message: 'Erfundene Meldung',
              code: 100,
              error_subcode: 33,
            },
          })
        )
      );
      const err = await failure();
      expect(err.details.unreadable).toBeUndefined();
      expect(err.details).toMatchObject({
        unavailable: false,
        status: 200,
        code: 100,
        subcode: 33,
      });
      expect(err.message).not.toContain('unreadable');
    });

    it.each([400, 403, 404, 429])(
      'throws a plain error for HTTP %s with HTML, without unreadable',
      async (status) => {
        fetchMock.mockResolvedValue(answer('<html>Erfunden</html>', status));
        const err = await failure();
        expect(err.details.unreadable).toBeUndefined();
        expect(err.details).toMatchObject({ unavailable: false, status });
        expect(err.message).not.toContain('unreadable');
      }
    );

    it('throws a plain error for HTTP 500 with an empty body, without unreadable', async () => {
      fetchMock.mockResolvedValue(answer('', 500));
      const err = await failure();
      expect(err.details.unreadable).toBeUndefined();
      expect(err.details.status).toBe(500);
    });

    it('throws unavailable for a network error', async () => {
      fetchMock.mockRejectedValue(
        new Error(`fetch failed access_token=${accessToken}`)
      );
      const err = await failure();
      expect(err.details).toEqual({ unavailable: true });
      expect(err.message).toBe('platform unavailable');
    });
  });

  describe('token', () => {
    it.each([
      ['an empty body', () => answer('')],
      ['HTML', () => answer(`<html>${accessToken}</html>`)],
      [
        'an error of Meta',
        () =>
          answer(
            JSON.stringify({
              error: { message: `access_token=${accessToken}`, code: 190 },
            }),
            401
          ),
      ],
    ])('is not in the error for %s', async (_name, make) => {
      fetchMock.mockResolvedValue(make());
      const err = await failure();
      expect(err.message).not.toContain(accessToken);
      expect(JSON.stringify(err.details)).not.toContain(accessToken);
    });

    it('is not in the error for a network error', async () => {
      fetchMock.mockRejectedValue(new Error(`boom ${accessToken}`));
      const err = await failure();
      expect(err.message).not.toContain(accessToken);
      expect(JSON.stringify(err.details)).not.toContain(accessToken);
    });
  });
});

describe('metaGraph usage header (PR 73)', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = original;
  });

  const withHeader = (
    value: string | null,
    body = '{"data": []}',
    status = 200
  ) =>
    new Response(body, {
      status,
      headers: value === null ? {} : { 'x-business-use-case-usage': value },
    });

  it('records the header of an answer into the meter', async () => {
    fetchMock.mockResolvedValue(
      withHeader(JSON.stringify({ '1': [{ call_count: 64 }] }))
    );
    const usage = new InboxUsageMeter();
    await metaGraph('GET', accessToken, '123/media', {}, usage);
    expect(usage.usage).toEqual({ percent: 64, regainMinutes: 0 });
  });

  it('records the header of an error answer as well', async () => {
    fetchMock.mockResolvedValue(
      withHeader(
        JSON.stringify({ '1': [{ call_count: 100 }] }),
        '{"error": {"message": "x", "code": 4}}',
        400
      )
    );
    const usage = new InboxUsageMeter();
    await expect(
      metaGraph('GET', accessToken, '123/media', {}, usage)
    ).rejects.toBeInstanceOf(InboxPlatformError);
    expect(usage.usage?.percent).toBe(100);
  });

  it('leaves the meter empty without the header', async () => {
    fetchMock.mockResolvedValue(withHeader(null));
    const usage = new InboxUsageMeter();
    await metaGraph('GET', accessToken, '123/media', {}, usage);
    expect(usage.usage).toBeNull();
  });

  it('works without a meter, and with an answer that has no headers at all', async () => {
    fetchMock.mockResolvedValue(withHeader('{"1": [{"call_count": 5}]}'));
    await expect(
      metaGraph('GET', accessToken, '123/media', {})
    ).resolves.toEqual({ data: [] });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] as unknown[] }),
    });
    const usage = new InboxUsageMeter();
    await expect(
      metaGraph('GET', accessToken, '123/media', {}, usage)
    ).resolves.toEqual({ data: [] });
    expect(usage.usage).toBeNull();
  });
});

describe('paging helpers (PR 73)', () => {
  it('hasMore is true only with paging.next', () => {
    expect(hasMore({ paging: { next: 'https://x' } })).toBe(true);
    expect(hasMore({ paging: { cursors: { after: 'abc' } } })).toBe(false);
    expect(hasMore({ data: [] })).toBe(false);
    expect(hasMore(undefined)).toBe(false);
    expect(hasMore(null)).toBe(false);
  });

  it('afterCursor gives the cursor only while there is a next page', () => {
    expect(
      afterCursor({
        paging: { next: 'https://x', cursors: { after: 'QVFI_1=' } },
      })
    ).toBe('QVFI_1=');
    expect(afterCursor({ paging: { cursors: { after: 'QVFI' } } })).toBeNull();
    expect(afterCursor({ paging: { next: 'https://x' } })).toBeNull();
    expect(afterCursor(undefined)).toBeNull();
  });

  it('afterCursor drops a cursor that is not safe for a query', () => {
    for (const after of ['a/b', 'a&b=1', '', 5, 'x'.repeat(513)]) {
      expect(
        afterCursor({ paging: { next: 'https://x', cursors: { after } } })
      ).toBeNull();
    }
  });

  it('timeOf reads ISO strings of Meta and gives NaN otherwise', () => {
    expect(timeOf('2026-11-02T10:00:00+0000')).toBe(
      Date.parse('2026-11-02T10:00:00Z')
    );
    expect(timeOf(undefined)).toBeNaN();
    expect(timeOf(5)).toBeNaN();
    expect(timeOf('gestern')).toBeNaN();
  });

  it('newSince counts a time at or after since, not before', () => {
    const since = new Date('2026-11-02T10:00:00Z');
    expect(newSince('2026-11-02T10:00:00+0000', since)).toBe(true);
    expect(newSince('2026-11-02T10:00:01+0000', since)).toBe(true);
    expect(newSince('2026-11-02T09:59:59+0000', since)).toBe(false);
    expect(newSince('2026-11-01T10:00:00+0000', null)).toBe(true);
  });

  it('newSince counts a comment without a readable time', () => {
    const since = new Date('2026-11-02T10:00:00Z');
    expect(newSince(null, since)).toBe(true);
    expect(newSince('kaputt', since)).toBe(true);
  });
});

describe('window helpers (PR 73)', () => {
  const from = new Date('2026-10-18T12:00:00Z');
  const before = new Date('2026-11-10T00:00:00Z');

  it('inPostWindow counts a time at or after postsFrom and before postsBefore', () => {
    const window = { postsFrom: from, postsBefore: before };
    expect(inPostWindow('2026-10-18T12:00:00+0000', window)).toBe(true);
    expect(inPostWindow('2026-11-09T23:59:59+0000', window)).toBe(true);
    expect(inPostWindow('2026-10-18T11:59:59+0000', window)).toBe(false);
    expect(inPostWindow('2026-11-10T00:00:00+0000', window)).toBe(false);
  });

  it('inPostWindow has no bound where the window has none', () => {
    expect(
      inPostWindow('2020-01-01T00:00:00+0000', {
        postsFrom: null,
        postsBefore: before,
      })
    ).toBe(true);
    expect(
      inPostWindow('2030-01-01T00:00:00+0000', {
        postsFrom: from,
        postsBefore: null,
      })
    ).toBe(true);
  });

  it('inPostWindow counts a post without a readable time', () => {
    const window = { postsFrom: from, postsBefore: before };
    expect(inPostWindow(undefined, window)).toBe(true);
    expect(inPostWindow('kaputt', window)).toBe(true);
  });

  it('beforePostWindow is true only for a readable time before postsFrom', () => {
    expect(
      beforePostWindow('2026-10-18T11:59:59+0000', { postsFrom: from })
    ).toBe(true);
    expect(
      beforePostWindow('2026-10-18T12:00:00+0000', { postsFrom: from })
    ).toBe(false);
    expect(
      beforePostWindow('2020-01-01T00:00:00+0000', { postsFrom: null })
    ).toBe(false);
    expect(beforePostWindow(undefined, { postsFrom: from })).toBe(false);
  });

  it('isUnknownObject is true only for code 100 with subcode 33', () => {
    const error = (code?: number, subcode?: number) =>
      new InboxPlatformError({
        unavailable: false,
        status: 400,
        code,
        subcode,
      });
    expect(isUnknownObject(error(100, 33))).toBe(true);
    expect(isUnknownObject(error(100, 1))).toBe(false);
    expect(isUnknownObject(error(190, 33))).toBe(false);
    expect(isUnknownObject(new Error('x'))).toBe(false);
    expect(isUnknownObject(new InboxPlatformError({ unavailable: true }))).toBe(
      false
    );
  });
});
