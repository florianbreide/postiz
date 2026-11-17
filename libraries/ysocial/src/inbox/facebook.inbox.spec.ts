import { randomBytes } from 'crypto';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InboxPlatformError } from './inbox.rules';
import { FacebookInbox } from './facebook.inbox';

// Invented ids. Posts and comments of a Page are <digits>_<digits>.
const PAGE = '100000000000001';
const POST = `${PAGE}_200000000000001`;
const POST_2 = `${PAGE}_200000000000002`;
const COMMENT = '200000000000001_300000000000001';
const COMMENT_2 = '200000000000001_300000000000002';
const REPLY = '300000000000001_400000000000001';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

const pageToken = randomBytes(24).toString('hex');
// The Page token is the whole Integration.token, no "___" part.
const channel = { internalId: PAGE, token: pageToken };

const FROM_ID = '500000000000777';
const FROM_NAME = 'Erfundene Person';

const json = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

describe('FacebookInbox', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;
  let inbox: FacebookInbox;

  const respond = (handler: Handler) => {
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      handler(new URL(url), init)
    );
  };
  const call = (index = 0) => {
    const [url, init] = fetchMock.mock.calls[index];
    return { raw: url as string, url: new URL(url), init: init as any };
  };
  const bodyOf = (index = 0) => new URLSearchParams(call(index).init.body);

  // One post with one top-level comment and one reply.
  const feed = (url: URL) =>
    url.pathname.endsWith(`/${PAGE}/published_posts`)
      ? json({ data: [{ id: POST }] })
      : json({
          data: [
            {
              id: COMMENT,
              comments: { data: [{ id: REPLY }] },
            },
          ],
        });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    inbox = new FacebookInbox();
  });

  afterEach(() => {
    global.fetch = original;
  });

  it('is the provider "facebook"', () => {
    expect(inbox.identifier).toBe('facebook');
  });

  describe('listComments', () => {
    it('reads the latest 10 posts of the Page with a fixed field list', async () => {
      respond(() => json({ data: [] }));
      expect(await inbox.listComments(channel)).toEqual([]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call();
      expect(`${url.origin}${url.pathname}`).toBe(
        `${GRAPH}/${PAGE}/published_posts`
      );
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect([...url.searchParams.keys()].sort()).toEqual([
        'access_token',
        'fields',
        'limit',
      ]);
      expect(url.searchParams.get('fields')).toBe(
        'id,permalink_url,created_time,status_type'
      );
      expect(url.searchParams.get('limit')).toBe('10');
    });

    it('reads up to 50 top-level comments per post, newest first, with replies', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({ data: [] })
      );
      await inbox.listComments(channel);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url, init } = call(1);
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${POST}/comments`);
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect([...url.searchParams.keys()].sort()).toEqual([
        'access_token',
        'fields',
        'filter',
        'limit',
        'order',
        'summary',
      ]);
      const fields = 'id,message,from,created_time,like_count,is_hidden';
      expect(url.searchParams.get('fields')).toBe(
        `${fields},comments{${fields}}`
      );
      expect(url.searchParams.get('filter')).toBe('toplevel');
      expect(url.searchParams.get('order')).toBe('reverse_chronological');
      expect(url.searchParams.get('summary')).toBe('true');
      expect(url.searchParams.get('limit')).toBe('50');
    });

    it('maps posts, comments and replies', async () => {
      respond((url) => {
        if (url.pathname.endsWith('/published_posts')) {
          return json({
            data: [
              {
                id: POST,
                permalink_url: 'https://www.facebook.com/erfunden/posts/1',
                created_time: '2026-11-01T10:00:00+0000',
                status_type: 'added_photos',
              },
            ],
          });
        }
        return json({
          data: [
            {
              id: COMMENT,
              message: 'Erfundener Kommentar',
              from: { name: FROM_NAME, id: FROM_ID },
              created_time: '2026-11-02T10:00:00+0000',
              like_count: 4,
              is_hidden: true,
              comments: {
                data: [
                  {
                    id: REPLY,
                    message: 'Erfundene Antwort',
                    from: { name: 'Erfundene Seite', id: '500000000000888' },
                    created_time: '2026-11-02T11:00:00+0000',
                    like_count: 1,
                    is_hidden: false,
                  },
                ],
              },
            },
          ],
          summary: { total_count: 7, order: 'reverse_chronological' },
        });
      });

      const posts = await inbox.listComments(channel);

      expect(posts).toEqual([
        {
          id: POST,
          permalink: 'https://www.facebook.com/erfunden/posts/1',
          timestamp: '2026-11-01T10:00:00+0000',
          mediaType: 'added_photos',
          commentsCount: 7,
          comments: [
            {
              id: COMMENT,
              text: 'Erfundener Kommentar',
              username: FROM_NAME,
              timestamp: '2026-11-02T10:00:00+0000',
              likeCount: 4,
              hidden: true,
              replies: [
                {
                  id: REPLY,
                  text: 'Erfundene Antwort',
                  username: 'Erfundene Seite',
                  timestamp: '2026-11-02T11:00:00+0000',
                  likeCount: 1,
                  hidden: false,
                },
              ],
            },
          ],
        },
      ]);
    });

    it('never outputs from.id', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [
                {
                  id: COMMENT,
                  message: 'Erfundener Kommentar',
                  from: { name: FROM_NAME, id: FROM_ID },
                  comments: {
                    data: [
                      {
                        id: REPLY,
                        from: { name: FROM_NAME, id: FROM_ID },
                      },
                    ],
                  },
                },
              ],
            })
      );
      const posts = await inbox.listComments(channel);
      expect(JSON.stringify(posts)).not.toContain(FROM_ID);
      expect(JSON.stringify(posts)).toContain(FROM_NAME);
    });

    it('falls back to defaults for missing or wrongly typed fields', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({
              data: [
                {
                  id: POST,
                  permalink_url: '',
                  created_time: 5,
                  status_type: null,
                },
                { id: POST_2 },
              ],
            })
          : json({
              data: [
                { id: COMMENT },
                {
                  id: COMMENT_2,
                  message: 5,
                  from: { id: FROM_ID },
                  like_count: -3,
                  is_hidden: 'true',
                  comments: 'kaputt',
                },
              ],
            })
      );
      const posts = await inbox.listComments(channel);
      expect(posts).toHaveLength(2);
      expect(posts[0]).toMatchObject({
        id: POST,
        permalink: null,
        timestamp: null,
        mediaType: null,
        commentsCount: 0,
      });
      const empty: Record<string, unknown> = {
        text: '',
        username: null,
        timestamp: null,
        likeCount: 0,
        hidden: false,
        replies: [],
      };
      expect(posts[0].comments).toEqual([
        { id: COMMENT, ...empty },
        { id: COMMENT_2, ...empty },
      ]);
    });

    it('rounds the like count down and reads the total from summary.total_count', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [{ id: COMMENT, like_count: 2.9 }],
              summary: { total_count: 12.7 },
            })
      );
      const [post] = await inbox.listComments(channel);
      expect(post.commentsCount).toBe(12);
      expect(post.comments[0].likeCount).toBe(2);
    });

    it('drops posts, comments and replies with an invalid id', async () => {
      respond((url) => {
        if (url.pathname.endsWith('/published_posts')) {
          return json({
            data: [
              { id: '../me' },
              { id: POST },
              {},
              { id: 'a_b' },
              { id: `${'1'.repeat(65)}` },
              { id: 12345 },
            ],
          });
        }
        return json({
          data: [
            { id: '1/2', message: 'weg' },
            {
              id: COMMENT,
              comments: { data: [{ id: 'a.b' }, { id: REPLY }, { id: '1__' }] },
            },
          ],
        });
      });
      const posts = await inbox.listComments(channel);
      expect(posts.map((post) => post.id)).toEqual([POST]);
      expect(posts[0].comments.map((comment) => comment.id)).toEqual([COMMENT]);
      expect(posts[0].comments[0].replies.map((r) => r.id)).toEqual([REPLY]);
      // Page feed and comments of the one valid post, nothing else.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('accepts an id of exactly 64 characters and drops one of 65', async () => {
      const ok = `${'1'.repeat(32)}_${'2'.repeat(31)}`;
      const tooLong = `${'1'.repeat(32)}_${'2'.repeat(32)}`;
      expect(ok).toHaveLength(64);
      expect(tooLong).toHaveLength(65);
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: ok }, { id: tooLong }] })
          : json({ data: [] })
      );
      const posts = await inbox.listComments(channel);
      expect(posts.map((post) => post.id)).toEqual([ok]);
    });

    it('ignores an answer without a data list', async () => {
      respond(() => json({ data: 'kaputt' }));
      expect(await inbox.listComments(channel)).toEqual([]);
      respond(() => json({}));
      expect(await inbox.listComments(channel)).toEqual([]);
    });

    it.each([`${PAGE}_1`, '../me', '1/2', '', 'abc', '1.2', 'x'])(
      'does not call fetch for the Page id "%s"',
      async (internalId) => {
        respond(() => json({ data: [] }));
        await expect(
          inbox.listComments({ ...channel, internalId })
        ).rejects.toThrow('invalid platform id');
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('does not call fetch for a Page id longer than 64 digits', async () => {
      await expect(
        inbox.listComments({ ...channel, internalId: '1'.repeat(65) })
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends only the token of the channel, in the query of every read', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }, { id: POST_2 }] })
          : json({ data: [] })
      );
      await inbox.listComments(channel);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        expect(call(i).url.searchParams.get('access_token')).toBe(pageToken);
        expect(call(i).url.host).toBe('graph.facebook.com');
      }
      // The two comment reads go to the two posts.
      expect([1, 2].map((i) => call(i).url.pathname).sort()).toEqual([
        `/${META_GRAPH_API_VERSION}/${POST}/comments`,
        `/${META_GRAPH_API_VERSION}/${POST_2}/comments`,
      ]);
    });
  });

  describe('ownsComment', () => {
    it('is true for a top-level comment of a listed post', async () => {
      respond(feed);
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(true);

      // It reads the list, nothing writes.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 2; i++) {
        expect(call(i).init.method).toBe('GET');
      }
      expect(call(0).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${PAGE}/published_posts`
      );
      expect(call(1).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${POST}/comments`
      );
    });

    it('is true for a reply in the list', async () => {
      respond(feed);
      expect(await inbox.ownsComment(channel, REPLY)).toBe(true);
    });

    it('is false for a valid id that the list does not contain', async () => {
      respond(feed);
      expect(await inbox.ownsComment(channel, COMMENT_2)).toBe(false);
      // The id of the post is not a comment of it.
      expect(await inbox.ownsComment(channel, POST)).toBe(false);
    });

    it('is false for a comment on a post beyond the latest posts', async () => {
      // Page feed knows no posts, so no comment is listed.
      respond(() => json({ data: [] }));
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('is false for a comment that Meta lists only under an invalid reply id', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [{ id: COMMENT, comments: { data: [{ id: 'a.b' }] } }],
            })
      );
      expect(await inbox.ownsComment(channel, 'a.b')).toBe(false);
    });

    it.each(['../me', '1/2', '1.2', '', 'abc', '1__', `${'1'.repeat(65)}`])(
      'is false for the invalid id "%s" and calls no fetch',
      async (id) => {
        respond(feed);
        expect(await inbox.ownsComment(channel, id)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('is false for a non-string id and calls no fetch', async () => {
      respond(feed);
      expect(await inbox.ownsComment(channel, undefined as any)).toBe(false);
      expect(await inbox.ownsComment(channel, 5 as any)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws the error of Meta, also one that looks like an unknown object', async () => {
      respond(() =>
        json(
          {
            error: {
              message: 'Unsupported get request. Object does not exist',
              code: 100,
              error_subcode: 33,
            },
          },
          400
        )
      );
      await expect(inbox.ownsComment(channel, COMMENT)).rejects.toMatchObject({
        details: { status: 400, code: 100, subcode: 33 },
      });
    });

    it('throws an error of Meta on the comment read of a post', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({ error: { message: 'Erfundener Fehler', code: 190 } }, 401)
      );
      await expect(inbox.ownsComment(channel, COMMENT)).rejects.toMatchObject({
        details: { status: 401, code: 190 },
      });
    });

    it('throws unavailable on a network error', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      const err = await inbox.ownsComment(channel, COMMENT).catch((e) => e);
      expect(err).toBeInstanceOf(InboxPlatformError);
      expect(err.details).toEqual({ unavailable: true });
    });

    it('throws for a Page id that is not valid', async () => {
      await expect(
        inbox.ownsComment({ ...channel, internalId: `${PAGE}_1` }, COMMENT)
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reply', () => {
    it('posts the token and the message in the body, not in the URL', async () => {
      respond(() => json({ id: REPLY }));
      const message = 'Erfundene Antwort mit Umlauten äöü & Sonderzeichen=1';
      expect(await inbox.reply(channel, COMMENT, message)).toEqual({
        id: REPLY,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { raw, init } = call();
      expect(raw).toBe(`${GRAPH}/${COMMENT}/comments`);
      expect(init.method).toBe('POST');
      expect([...bodyOf().keys()].sort()).toEqual(['access_token', 'message']);
      expect(bodyOf().get('message')).toBe(message);
      expect(bodyOf().get('access_token')).toBe(pageToken);
      expect(raw).not.toContain(pageToken);
      expect(raw).not.toContain('Erfundene');
      expect(raw).not.toContain('?');
    });

    it('returns id null when Meta sends none or an invalid one', async () => {
      for (const body of [{}, { id: '../x' }, { id: 5 }, { id: 'a_b' }]) {
        respond(() => json(body));
        expect(await inbox.reply(channel, COMMENT, 'x')).toEqual({ id: null });
      }
    });

    it('throws for an error of Meta', async () => {
      respond(() =>
        json({ error: { message: 'Erfundener Fehler', code: 200 } }, 403)
      );
      await expect(inbox.reply(channel, COMMENT, 'x')).rejects.toMatchObject({
        details: { status: 403, code: 200 },
      });
    });
  });

  describe('hide', () => {
    it.each([
      [true, 'true'],
      [false, 'false'],
    ])('posts is_hidden=%s in the body', async (hide, value) => {
      respond(() => json({ success: true }));
      await inbox.hide(channel, COMMENT, hide);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { raw, init } = call();
      expect(raw).toBe(`${GRAPH}/${COMMENT}`);
      expect(init.method).toBe('POST');
      expect([...bodyOf().keys()].sort()).toEqual([
        'access_token',
        'is_hidden',
      ]);
      expect(bodyOf().get('is_hidden')).toBe(value);
      expect(bodyOf().get('access_token')).toBe(pageToken);
      expect(raw).not.toContain(pageToken);
      expect(raw).not.toContain('?');
    });

    it('throws InboxPlatformError without success: true', async () => {
      for (const body of [{}, { success: false }, { success: 'true' }]) {
        respond(() => json(body));
        await expect(inbox.hide(channel, COMMENT, true)).rejects.toBeInstanceOf(
          InboxPlatformError
        );
        await expect(
          inbox.hide(channel, COMMENT, false)
        ).rejects.toBeInstanceOf(InboxPlatformError);
      }
    });
  });

  describe('remove', () => {
    it('sends DELETE with the token in the query and no body', async () => {
      respond(() => json({ success: true }));
      await inbox.remove(channel, COMMENT);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call();
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${COMMENT}`);
      expect([...url.searchParams.keys()]).toEqual(['access_token']);
      expect(url.searchParams.get('access_token')).toBe(pageToken);
    });

    it('throws InboxPlatformError without success: true', async () => {
      for (const body of [{}, { success: false }, { success: 1 }]) {
        respond(() => json(body));
        await expect(inbox.remove(channel, COMMENT)).rejects.toBeInstanceOf(
          InboxPlatformError
        );
      }
    });
  });

  describe('errors', () => {
    const failure = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (err) {
        return err as InboxPlatformError;
      }
      throw new Error('expected a rejection');
    };

    it('turns a Graph error into InboxPlatformError with codes and a sanitized reason', async () => {
      const longToken = randomBytes(30).toString('hex');
      respond(() =>
        json(
          {
            error: {
              message: `(#200) Fehler bei https://graph.facebook.com/x?access_token=${pageToken}&a=1 und ${longToken}`,
              code: 200,
              error_subcode: 1446036,
            },
          },
          403
        )
      );
      const err = await failure(inbox.reply(channel, COMMENT, 'x'));
      expect(err).toBeInstanceOf(InboxPlatformError);
      expect(err.details).toMatchObject({
        unavailable: false,
        status: 403,
        code: 200,
        subcode: 1446036,
      });
      expect(err.details.reason).toContain('Fehler bei');
      expect(err.details.reason).not.toContain(pageToken);
      expect(err.details.reason).not.toContain(longToken);
      expect(err.message).toBe('platform error status=403 code=200/1446036');
    });

    it('treats an error body with status 200 as an error', async () => {
      respond(() => json({ error: { message: 'kaputt', code: 1 } }, 200));
      const err = await failure(inbox.listComments(channel));
      expect(err.details).toMatchObject({ status: 200, code: 1 });
    });

    it('handles a non-JSON error response', async () => {
      respond(
        () =>
          ({
            ok: false,
            status: 500,
            json: async () => {
              throw new Error('no json');
            },
          } as unknown as Response)
      );
      const err = await failure(inbox.listComments(channel));
      expect(err.details).toEqual({
        unavailable: false,
        status: 500,
        code: undefined,
        subcode: undefined,
        reason: undefined,
      });
    });

    it('marks a network error as unavailable and does not pass on the cause', async () => {
      fetchMock.mockRejectedValue(
        new Error(`fetch failed: ${GRAPH}/x?access_token=${pageToken}`)
      );
      const err = await failure(inbox.listComments(channel));
      expect(err).toBeInstanceOf(InboxPlatformError);
      expect(err.details).toEqual({ unavailable: true });
      expect(err.message).not.toContain(pageToken);
    });

    it('marks a timeout as unavailable and sets an abort signal', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      );
      const err = await failure(inbox.remove(channel, COMMENT));
      expect(err.details.unavailable).toBe(true);
      expect(call().init.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not call fetch for an invalid id on any call', async () => {
      for (const id of ['../me', '1/2', '1.2', '', 'abc', '1'.repeat(65)]) {
        await expect(inbox.reply(channel, id, 'x')).rejects.toThrow(
          'invalid platform id'
        );
        await expect(inbox.hide(channel, id, true)).rejects.toThrow(
          'invalid platform id'
        );
        await expect(inbox.remove(channel, id)).rejects.toThrow(
          'invalid platform id'
        );
        // ownsComment answers false instead of throwing.
        await expect(inbox.ownsComment(channel, id)).resolves.toBe(false);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
