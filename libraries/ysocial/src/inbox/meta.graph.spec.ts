import { randomBytes } from 'crypto';
import { InboxPlatformError } from './inbox.rules';
import { metaGraph } from './meta.graph';

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
      ['a body that the timeout cut off', () => answer('{"success": tr')],
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
