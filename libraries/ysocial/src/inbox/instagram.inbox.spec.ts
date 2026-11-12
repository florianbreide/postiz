import { randomBytes } from 'crypto';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InboxPlatformError } from './inbox.rules';
import { InstagramInbox } from './instagram.inbox';

const IG = '17840000000000001';
const MEDIA = '17900000000000001';
const MEDIA_2 = '17900000000000002';
const COMMENT = '17950000000000001';
const COMMENT_2 = '17950000000000002';
const REPLY = '17950000000000003';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

const pageToken = randomBytes(24).toString('hex');
const userToken = randomBytes(24).toString('hex');
const channel = { internalId: IG, token: `${pageToken}___${userToken}` };

const json = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

describe('InstagramInbox', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;
  let inbox: InstagramInbox;

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

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    inbox = new InstagramInbox();
  });

  afterEach(() => {
    global.fetch = original;
  });

  it('is the provider "instagram"', () => {
    expect(inbox.identifier).toBe('instagram');
  });

  describe('listComments', () => {
    it('reads the latest 10 posts with a fixed field list', async () => {
      respond(() => json({ data: [] }));
      expect(await inbox.listComments(channel)).toEqual([]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call();
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${IG}/media`);
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(url.searchParams.get('fields')).toBe(
        'id,permalink,timestamp,media_type,comments_count'
      );
      expect(url.searchParams.get('limit')).toBe('10');
    });

    it('reads up to 50 comments per post with replies and maps the answer', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${IG}/media`)) {
          return json({
            data: [
              {
                id: MEDIA,
                permalink: 'https://www.instagram.com/p/ERFUNDEN/',
                timestamp: '2026-11-01T10:00:00+0000',
                media_type: 'IMAGE',
                comments_count: 3,
              },
            ],
          });
        }
        return json({
          data: [
            {
              id: COMMENT,
              text: 'Erfundener Kommentar',
              username: 'erfundene_person',
              timestamp: '2026-11-02T10:00:00+0000',
              like_count: 4,
              hidden: true,
              replies: {
                data: [
                  {
                    id: REPLY,
                    text: 'Erfundene Antwort',
                    username: 'konto',
                    timestamp: '2026-11-02T11:00:00+0000',
                    like_count: 1,
                  },
                ],
              },
            },
            // Missing fields fall back to defaults.
            { id: COMMENT_2 },
          ],
        });
      });

      const posts = await inbox.listComments(channel);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url } = call(1);
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${MEDIA}/comments`);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('fields')).toBe(
        'id,text,timestamp,username,like_count,hidden,replies{id,text,timestamp,username,like_count,hidden}'
      );
      expect(posts).toEqual([
        {
          id: MEDIA,
          permalink: 'https://www.instagram.com/p/ERFUNDEN/',
          timestamp: '2026-11-01T10:00:00+0000',
          mediaType: 'IMAGE',
          commentsCount: 3,
          comments: [
            {
              id: COMMENT,
              text: 'Erfundener Kommentar',
              username: 'erfundene_person',
              timestamp: '2026-11-02T10:00:00+0000',
              likeCount: 4,
              hidden: true,
              replies: [
                {
                  id: REPLY,
                  text: 'Erfundene Antwort',
                  username: 'konto',
                  timestamp: '2026-11-02T11:00:00+0000',
                  likeCount: 1,
                  hidden: false,
                },
              ],
            },
            {
              id: COMMENT_2,
              text: '',
              username: null,
              timestamp: null,
              likeCount: 0,
              hidden: false,
              replies: [],
            },
          ],
        },
      ]);
    });

    it('does not read comments of a post with comments_count 0 or without it', async () => {
      respond(() =>
        json({
          data: [{ id: MEDIA, comments_count: 0 }, { id: MEDIA_2 }],
        })
      );
      const posts = await inbox.listComments(channel);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(posts.map((post) => post.comments)).toEqual([[], []]);
      expect(posts[0]).toMatchObject({
        permalink: null,
        timestamp: null,
        mediaType: null,
        commentsCount: 0,
      });
    });

    it('drops posts, comments and replies with an invalid id', async () => {
      respond((url) => {
        if (url.pathname.endsWith('/media')) {
          return json({
            data: [
              { id: '../me', comments_count: 1 },
              { id: MEDIA, comments_count: 2 },
              { comments_count: 1 },
            ],
          });
        }
        return json({
          data: [
            { id: '1/2', text: 'weg' },
            {
              id: COMMENT,
              replies: { data: [{ id: 'a.b' }, { id: REPLY }] },
            },
          ],
        });
      });
      const posts = await inbox.listComments(channel);
      expect(posts.map((post) => post.id)).toEqual([MEDIA]);
      expect(posts[0].comments.map((comment) => comment.id)).toEqual([COMMENT]);
      expect(posts[0].comments[0].replies.map((r) => r.id)).toEqual([REPLY]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends only the page token, never the user token', async () => {
      respond((url) =>
        url.pathname.endsWith('/media')
          ? json({ data: [{ id: MEDIA, comments_count: 1 }] })
          : json({ data: [] })
      );
      await inbox.listComments(channel);
      for (let i = 0; i < fetchMock.mock.calls.length; i++) {
        expect(call(i).url.searchParams.get('access_token')).toBe(pageToken);
        expect(call(i).raw).not.toContain(userToken);
        expect(call(i).raw).not.toContain('___');
      }
    });
  });

  describe('ownsComment', () => {
    const media = (owner: unknown) => json({ id: MEDIA, owner });

    it('is true for a comment on media owned by the channel', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}`)
          ? json({ id: COMMENT, media: { id: MEDIA } })
          : media({ id: IG })
      );
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(call(0).url.searchParams.get('fields')).toBe('id,media,parent_id');
      expect(call(1).url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${MEDIA}`);
      expect(call(1).url.searchParams.get('fields')).toBe('id,owner');
      expect(call(0).init.method).toBe('GET');
      expect(call(1).init.method).toBe('GET');
      expect(call(0).url.searchParams.get('access_token')).toBe(pageToken);
    });

    it('is false for media owned by someone else', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}`)
          ? json({ id: COMMENT, media: { id: MEDIA } })
          : media({ id: '17840000000000999' })
      );
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
    });

    it('is false when owner is missing', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}`)
          ? json({ id: COMMENT, media: { id: MEDIA } })
          : json({ id: MEDIA })
      );
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
    });

    it('follows parent_id for a reply without media', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${REPLY}`)) {
          return json({ id: REPLY, parent_id: COMMENT });
        }
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return json({ id: COMMENT, media: { id: MEDIA } });
        }
        return media({ id: IG });
      });
      expect(await inbox.ownsComment(channel, REPLY)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(1).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(call(1).url.searchParams.get('fields')).toBe('id,media');
    });

    it('is false for a reply under a foreign post', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${REPLY}`)) {
          return json({ id: REPLY, parent_id: COMMENT });
        }
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return json({ id: COMMENT, media: { id: MEDIA } });
        }
        return media({ id: '17840000000000999' });
      });
      expect(await inbox.ownsComment(channel, REPLY)).toBe(false);
    });

    it('is false without media and parent_id, and reads nothing more', async () => {
      respond(() => json({ id: COMMENT }));
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('is false when the parent has no media either', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${REPLY}`)
          ? json({ id: REPLY, parent_id: COMMENT })
          : json({ id: COMMENT })
      );
      expect(await inbox.ownsComment(channel, REPLY)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('is false when media or parent_id is not a platform id', async () => {
      respond(() =>
        json({ id: COMMENT, media: { id: '../x' }, parent_id: 'a/b' })
      );
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      expect(raw).toBe(`${GRAPH}/${COMMENT}/replies`);
      expect(init.method).toBe('POST');
      expect(bodyOf().get('message')).toBe(message);
      expect(bodyOf().get('access_token')).toBe(pageToken);
      expect(bodyOf().toString()).not.toContain(userToken);
      expect(raw).not.toContain(pageToken);
      expect(raw).not.toContain('Erfundene');
      expect(raw).not.toContain('?');
    });

    it('returns id null when the platform sends none or an invalid one', async () => {
      respond(() => json({}));
      expect(await inbox.reply(channel, COMMENT, 'x')).toEqual({ id: null });
      respond(() => json({ id: '../x' }));
      expect(await inbox.reply(channel, COMMENT, 'x')).toEqual({ id: null });
    });
  });

  describe('hide', () => {
    it.each([
      [true, 'true'],
      [false, 'false'],
    ])('posts hide=%s in the body', async (hide, value) => {
      respond(() => json({ success: true }));
      await inbox.hide(channel, COMMENT, hide);
      const { raw, init } = call();
      expect(raw).toBe(`${GRAPH}/${COMMENT}`);
      expect(init.method).toBe('POST');
      expect(bodyOf().get('hide')).toBe(value);
      expect(bodyOf().get('access_token')).toBe(pageToken);
      expect(raw).not.toContain(pageToken);
    });

    it('throws without success: true', async () => {
      for (const body of [{}, { success: false }, { success: 'true' }]) {
        respond(() => json(body));
        await expect(inbox.hide(channel, COMMENT, true)).rejects.toBeInstanceOf(
          InboxPlatformError
        );
      }
    });
  });

  describe('remove', () => {
    it('sends DELETE with the page token in the query', async () => {
      respond(() => json({ success: true }));
      await inbox.remove(channel, COMMENT);
      const { url, init } = call();
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${COMMENT}`);
      expect(url.searchParams.get('access_token')).toBe(pageToken);
      expect(url.search).not.toContain(userToken);
    });

    it('throws without success: true', async () => {
      respond(() => json({ success: false }));
      await expect(inbox.remove(channel, COMMENT)).rejects.toBeInstanceOf(
        InboxPlatformError
      );
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
              message: `(#10) Fehler bei https://graph.facebook.com/x?access_token=${pageToken}&a=1 und ${longToken}`,
              code: 10,
              error_subcode: 2207,
            },
          },
          400
        )
      );
      const err = await failure(inbox.reply(channel, COMMENT, 'x'));
      expect(err).toBeInstanceOf(InboxPlatformError);
      expect(err.details).toMatchObject({
        unavailable: false,
        status: 400,
        code: 10,
        subcode: 2207,
      });
      expect(err.details.reason).toContain('Fehler bei');
      expect(err.details.reason).not.toContain(pageToken);
      expect(err.details.reason).not.toContain(longToken);
      expect(err.message).toBe('platform error status=400 code=10/2207');
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

    it('does not call fetch for an invalid id', async () => {
      for (const id of ['../me', '1/2', '1.2', '', 'x'.repeat(10), '123_456']) {
        await expect(inbox.reply(channel, id, 'x')).rejects.toThrow(
          'invalid platform id'
        );
        await expect(inbox.hide(channel, id, true)).rejects.toThrow();
        await expect(inbox.remove(channel, id)).rejects.toThrow();
        // ownsComment answers false instead of throwing.
        await expect(inbox.ownsComment(channel, id)).resolves.toBe(false);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not call fetch for an account id that is not digits only', async () => {
      respond(() => json({ data: [] }));
      await expect(
        inbox.listComments({ ...channel, internalId: `${IG}_1` })
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers false for an unknown comment (code 100, subcode 33)', async () => {
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
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['code 100 with another subcode', 100, 2207],
      ['code 100 without a subcode', 100, undefined],
      ['subcode 33 with another code', 10, 33],
      ['another code', 190, undefined],
    ])('still throws for %s', async (_n, code, subcode) => {
      respond(() =>
        json(
          {
            error: {
              message: 'Erfundener Fehler',
              code,
              error_subcode: subcode,
            },
          },
          400
        )
      );
      await expect(inbox.ownsComment(channel, COMMENT)).rejects.toMatchObject({
        details: { code, subcode },
      });
    });

    it('still throws unavailable when ownsComment gets no answer', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      await expect(inbox.ownsComment(channel, COMMENT)).rejects.toMatchObject({
        details: { unavailable: true },
      });
    });

    it('treats an id with "_" in a Graph answer as invalid', async () => {
      // media id, comment id, reply id, media.id and parent_id
      respond((url) => {
        if (url.pathname.endsWith('/media')) {
          return json({
            data: [
              { id: `${IG}_${MEDIA}`, comments_count: 1 },
              { id: MEDIA, comments_count: 2 },
            ],
          });
        }
        return json({
          data: [
            { id: `${MEDIA}_${COMMENT}`, text: 'weg' },
            {
              id: COMMENT,
              replies: { data: [{ id: `${COMMENT}_${REPLY}` }, { id: REPLY }] },
            },
          ],
        });
      });
      const posts = await inbox.listComments(channel);
      expect(posts.map((post) => post.id)).toEqual([MEDIA]);
      expect(posts[0].comments.map((c) => c.id)).toEqual([COMMENT]);
      expect(posts[0].comments[0].replies.map((r) => r.id)).toEqual([REPLY]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      respond(() => json({ id: COMMENT, media: { id: `${IG}_${MEDIA}` } }));
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockClear();
      respond(() => json({ id: COMMENT, parent_id: `${COMMENT}_${REPLY}` }));
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      respond(() => json({ id: `${COMMENT}_${REPLY}` }));
      expect(await inbox.reply(channel, COMMENT, 'x')).toEqual({ id: null });
    });
  });
});
