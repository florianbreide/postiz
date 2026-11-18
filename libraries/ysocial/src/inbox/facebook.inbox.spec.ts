import { randomBytes } from 'crypto';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import {
  InboxOwnershipUnknownError,
  InboxPlatformError,
  InboxUsageMeter,
  InboxWindow,
} from './inbox.rules';
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

// Fixed wall clock: the window is the 30 days before it.
const NOW = Date.parse('2026-11-17T12:00:00Z');
const RECENT = '2026-11-10T10:00:00+0000';

class TestFacebookInbox extends FacebookInbox {
  now = NOW;
  protected clock = () => this.now;
}

describe('FacebookInbox', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;
  let inbox: TestFacebookInbox;

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

  // One post of the window with one top-level comment and one reply, in
  // the one call of the window read.
  const feed = (url: URL) =>
    url.pathname.endsWith(`/${PAGE}/published_posts`)
      ? json({
          data: [
            {
              id: POST,
              created_time: RECENT,
              comments: {
                data: [{ id: COMMENT, comments: { data: [{ id: REPLY }] } }],
              },
            },
          ],
        })
      : json({ data: [] });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    inbox = new TestFacebookInbox();
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
      const fields =
        'id,message,from,created_time,like_count,is_hidden,message_tags';
      expect(url.searchParams.get('fields')).toBe(
        `${fields},comments.limit(25){${fields}}`
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
              fromOwner: false,
              mentions: [],
              replies: [
                {
                  id: REPLY,
                  text: 'Erfundene Antwort',
                  username: 'Erfundene Seite',
                  timestamp: '2026-11-02T11:00:00+0000',
                  likeCount: 1,
                  hidden: false,
                  fromOwner: false,
                  mentions: [],
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
        fromOwner: false,
        mentions: [],
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

      // It reads the window in one call, nothing writes.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(call(0).init.method).toBe('GET');
      expect(call(0).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${PAGE}/published_posts`
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
      respond(() =>
        json({
          data: [
            {
              id: POST,
              created_time: RECENT,
              comments: {
                data: [{ id: COMMENT, comments: { data: [{ id: 'a.b' }] } }],
              },
            },
          ],
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
      // The post has more comments than one page, so they are read on their own.
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({
              data: [
                {
                  id: POST,
                  created_time: RECENT,
                  comments: { data: [], paging: { next: 'https://x' } },
                },
              ],
            })
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

  describe('listItems (PR 73)', () => {
    const FIELDS =
      'id,message,from,created_time,like_count,is_hidden,message_tags';
    const POST_3 = `${PAGE}_200000000000003`;
    const COMMENT_3 = '200000000000003_300000000000003';
    const meter = () => new InboxUsageMeter();
    const window = (patch: Partial<InboxWindow> = {}): InboxWindow => ({
      since: null,
      postsFrom: new Date(NOW - 30 * 86_400_000),
      postsBefore: null,
      cursor: null,
      ...patch,
    });
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const comment = (id: string, created: string, replies: unknown[] = []) => ({
      id,
      message: 'Erfundener Text',
      from: { name: FROM_NAME, id: FROM_ID },
      created_time: created,
      like_count: 3,
      is_hidden: false,
      comments: { data: replies },
    });
    const post = (id: string, created: string, comments: unknown[] = []) => ({
      id,
      permalink_url: 'https://www.facebook.com/erfunden/posts/1',
      created_time: created,
      status_type: 'added_photos',
      comments: { data: comments },
    });

    it('reads published_posts with the comments embedded, 10 posts, no cursor', async () => {
      respond(() => json({ data: [] }));
      expect(await inbox.listItems(channel, window(), meter())).toEqual({
        posts: [],
        items: [],
        nextCursor: null,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call();
      expect(`${url.origin}${url.pathname}`).toBe(
        `${GRAPH}/${PAGE}/published_posts`
      );
      expect(init.method).toBe('GET');
      expect([...url.searchParams.keys()].sort()).toEqual([
        'access_token',
        'fields',
        'limit',
      ]);
      expect(url.searchParams.get('fields')).toBe(
        `id,permalink_url,created_time,status_type,comments.limit(50){${FIELDS},comments.limit(25){${FIELDS}}}`
      );
      // A small page: the call carries the comments and replies of 10 posts.
      expect(url.searchParams.get('limit')).toBe('10');
    });

    it('passes the cursor on as after', async () => {
      respond(() => json({ data: [] }));
      await inbox.listItems(channel, window({ cursor: 'QVFIUk1_-=' }), meter());
      expect(call().url.searchParams.get('after')).toBe('QVFIUk1_-=');
    });

    it('maps posts and flat items with postId and parentId', async () => {
      respond(() =>
        json({
          data: [
            post(POST, day(1), [
              comment(COMMENT, day(1), [
                { id: REPLY, message: 'Antwort', created_time: day(1) },
              ]),
            ]),
          ],
        })
      );
      const page = await inbox.listItems(channel, window(), meter());

      expect(page.posts).toEqual([
        {
          id: POST,
          permalink: 'https://www.facebook.com/erfunden/posts/1',
          timestamp: day(1),
          mediaType: 'added_photos',
          // A Page post has no comment count field.
          commentsCount: null,
          truncated: false,
        },
      ]);
      expect(page.items).toEqual([
        {
          id: COMMENT,
          postId: POST,
          parentId: null,
          text: 'Erfundener Text',
          username: FROM_NAME,
          timestamp: day(1),
          likeCount: 3,
          hidden: false,
          fromOwner: false,
          mentions: [],
        },
        expect.objectContaining({ id: REPLY, postId: POST, parentId: COMMENT }),
      ]);
      // The id of the person never leaves the provider.
      expect(JSON.stringify(page)).not.toContain(FROM_ID);
    });

    it('keeps only comments and replies at or after since', async () => {
      respond(() =>
        json({
          data: [
            post(POST, day(5), [
              comment(COMMENT, day(4), [{ id: REPLY, created_time: day(1) }]),
              comment(COMMENT_2, day(2)),
            ]),
          ],
        })
      );
      const since = new Date(day(2));
      const page = await inbox.listItems(channel, window({ since }), meter());
      // The old top-level comment is out, its new reply stays, and a
      // comment exactly at since counts.
      expect(page.items.map((item) => item.id)).toEqual([REPLY, COMMENT_2]);
      // The post is listed whatever since says.
      expect(page.posts.map((p) => p.id)).toEqual([POST]);
    });

    it('skips an older post on the way and goes on, the window ends after a page of older posts only', async () => {
      respond((url) =>
        url.searchParams.get('after') === 'A'
          ? json({
              data: [post(POST_2, day(40), [comment(COMMENT_2, day(40))])],
              paging: { next: 'https://x', cursors: { after: 'B' } },
            })
          : json({
              // A pinned post of long ago in front of newer ones.
              data: [
                post(POST_2, day(90), [comment(COMMENT_2, day(90))]),
                post(POST, day(2), [comment(COMMENT, day(2))]),
                post(POST_3, day(1), [comment(COMMENT_3, day(1))]),
              ],
              paging: { next: 'https://x', cursors: { after: 'A' } },
            })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([POST, POST_3]);
      expect(page.items.map((item) => item.id)).toEqual([COMMENT, COMMENT_3]);
      // The page after the first holds older posts only: the end, no page B.
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(1).url.searchParams.get('after')).toBe('A');
    });

    it('does not end the window on a page that holds one post of the window', async () => {
      respond((url) =>
        url.searchParams.get('after') === 'A'
          ? json({ data: [post(POST_3, day(3))] })
          : json({
              data: [post(POST_2, day(60)), post(POST, day(29))],
              paging: { next: 'https://x', cursors: { after: 'A' } },
            })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([POST, POST_3]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('with olderThan and postsAfter reads between the two, the end after a page below postsAfter', async () => {
      respond((url) =>
        url.searchParams.get('after') === 'A'
          ? json({
              data: [post(POST_3, day(60))],
              paging: { next: 'https://x', cursors: { after: 'B' } },
            })
          : json({
              data: [
                post(POST, day(2)),
                post(POST_2, day(15)),
                post(COMMENT_3.replace('_3', '_9'), day(45)),
              ],
              paging: { next: 'https://x', cursors: { after: 'A' } },
            })
      );
      const page = await inbox.listItems(
        channel,
        window({
          postsBefore: new Date(day(10)),
          postsFrom: new Date(day(30)),
        }),
        meter()
      );
      expect(page.posts.map((p) => p.id)).toEqual([POST_2]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(page.nextCursor).toBeNull();
    });

    it('with olderThan skips newer posts, takes older ones and has no lower bound', async () => {
      respond(() =>
        json({
          data: [
            post(POST, day(2), [comment(COMMENT, day(2))]),
            post(POST_2, day(40), [comment(COMMENT_2, day(40))]),
            post(POST_3, day(90), [comment(COMMENT_3, day(90))]),
          ],
        })
      );
      const page = await inbox.listItems(
        channel,
        window({ postsFrom: null, postsBefore: new Date(day(10)) }),
        meter()
      );
      expect(page.posts.map((p) => p.id)).toEqual([POST_2, POST_3]);
      expect(page.items.map((item) => item.id)).toEqual([COMMENT_2, COMMENT_3]);
    });

    it('reads the next page with after when the budget lasts, and ends with null', async () => {
      respond((url) =>
        url.searchParams.get('after') === 'PAGE2'
          ? json({ data: [post(POST_2, day(2))] })
          : json({
              data: [post(POST, day(1))],
              paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
            })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([POST, POST_2]);
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0).url.searchParams.has('after')).toBe(false);
      expect(call(1).url.searchParams.get('after')).toBe('PAGE2');
    });

    it('stops after the budget of 25 s and gives nextCursor', async () => {
      respond(() => {
        // Every call takes 30 s of wall clock.
        (inbox as TestFacebookInbox).now += 30_000;
        return json({
          data: [post(POST, day(1))],
          paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
        });
      });
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.nextCursor).toBe('PAGE2');
      expect(page.posts.map((p) => p.id)).toEqual([POST]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not stop for the budget on the last page: nextCursor null', async () => {
      respond(() => {
        (inbox as TestFacebookInbox).now += 30_000;
        return json({ data: [post(POST, day(1))] });
      });
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.nextCursor).toBeNull();
    });

    it('gives no cursor when paging.next is there but the cursor is unusable', async () => {
      respond(() =>
        json({
          data: [post(POST, day(1))],
          paging: { next: 'https://x', cursors: { after: 'a/b&c' } },
        })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('more than one page of comments', () => {
      it('reads the newest top-level comments on their own, reverse_chronological', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({
                data: [
                  {
                    ...post(POST, day(1)),
                    comments: { data: [], paging: { next: 'https://x' } },
                  },
                ],
              })
            : json({ data: [comment(COMMENT, day(1))] })
        );
        const page = await inbox.listItems(channel, window(), meter());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const { url, init } = call(1);
        expect(`${url.origin}${url.pathname}`).toBe(
          `${GRAPH}/${POST}/comments`
        );
        expect(init.method).toBe('GET');
        expect(url.searchParams.get('filter')).toBe('toplevel');
        expect(url.searchParams.get('order')).toBe('reverse_chronological');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('fields')).toBe(
          `${FIELDS},comments.limit(25){${FIELDS}}`
        );
        expect(page.items.map((item) => item.id)).toEqual([COMMENT]);
      });

      it('marks the post truncated when the newest comments have more pages', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({
                data: [
                  {
                    ...post(POST, day(1)),
                    comments: { data: [], paging: { next: 'https://x' } },
                  },
                ],
              })
            : json({
                data: [comment(COMMENT, day(1))],
                paging: { next: 'https://y' },
              })
        );
        const page = await inbox.listItems(channel, window(), meter());
        expect(page.posts[0].truncated).toBe(true);
      });

      it('reads the newest replies of a comment with more pages on their own, in parallel', async () => {
        const REPLY_2 = '300000000000001_400000000000009';
        respond((url) => {
          if (url.pathname.endsWith('/published_posts')) {
            return json({
              data: [
                post(POST, day(1), [
                  {
                    ...comment(COMMENT, day(1), [{ id: REPLY }]),
                    comments: {
                      data: [{ id: REPLY }],
                      paging: { next: 'https://x' },
                    },
                  },
                  {
                    ...comment(COMMENT_2, day(1)),
                    comments: { data: [], paging: { next: 'https://y' } },
                  },
                  comment(COMMENT_3, day(1)),
                ]),
              ],
            });
          }
          return json({
            data: [{ id: REPLY_2, created_time: day(0.1) }],
          });
        });
        const page = await inbox.listItems(channel, window(), meter());

        // The list, then one read per comment with more pages. None for the
        // comment that fits.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const reads = [call(1), call(2)];
        expect(reads.map((r) => r.url.pathname).sort()).toEqual(
          [
            `/${META_GRAPH_API_VERSION}/${COMMENT}/comments`,
            `/${META_GRAPH_API_VERSION}/${COMMENT_2}/comments`,
          ].sort()
        );
        for (const { url, init } of reads) {
          expect(init.method).toBe('GET');
          expect(url.searchParams.get('order')).toBe('reverse_chronological');
          expect(url.searchParams.get('limit')).toBe('25');
          expect(url.searchParams.get('fields')).toBe(FIELDS);
          expect(url.searchParams.has('filter')).toBe(false);
        }
        // The newest replies replace the oldest first page.
        expect(page.items.map((item) => item.id)).toEqual([
          COMMENT,
          REPLY_2,
          COMMENT_2,
          REPLY_2,
          COMMENT_3,
        ]);
        expect(
          page.items
            .filter((item) => item.id === REPLY_2)
            .map((i) => i.parentId)
        ).toEqual([COMMENT, COMMENT_2]);
        // The read of the replies has no further page: not truncated.
        expect(page.posts[0].truncated).toBe(false);
      });

      it('marks the post truncated when the newest replies have more pages', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({
                data: [
                  post(POST, day(1), [
                    {
                      ...comment(COMMENT, day(1)),
                      comments: { data: [], paging: { next: 'https://x' } },
                    },
                  ]),
                ],
              })
            : json({
                data: [{ id: REPLY, created_time: day(0.1) }],
                paging: { next: 'https://y' },
              })
        );
        const page = await inbox.listItems(channel, window(), meter());
        expect(page.posts[0].truncated).toBe(true);
      });

      it('throws the error of Meta when the read of the replies fails', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({
                data: [
                  post(POST, day(1), [
                    {
                      ...comment(COMMENT, day(1)),
                      comments: { data: [], paging: { next: 'https://x' } },
                    },
                  ]),
                ],
              })
            : json({ error: { message: 'x', code: 190 } }, 401)
        );
        await expect(
          inbox.listItems(channel, window(), meter())
        ).rejects.toMatchObject({ details: { status: 401, code: 190 } });
      });

      it('is not truncated and reads nothing more when everything fits one page', async () => {
        respond(() =>
          json({ data: [post(POST, day(1), [comment(COMMENT, day(1))])] })
        );
        const page = await inbox.listItems(channel, window(), meter());
        expect(page.posts[0].truncated).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it('drops entries with an invalid id', async () => {
      respond(() =>
        json({
          data: [
            post(POST, day(1), [
              comment('a.b', day(1)),
              comment(COMMENT, day(1), [{ id: '../x', created_time: day(1) }]),
            ]),
            post('../me', day(1), [comment(COMMENT_2, day(1))]),
          ],
        })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([POST]);
      expect(page.items.map((item) => item.id)).toEqual([COMMENT]);
    });

    it('records the usage header of every answer', async () => {
      respond(
        () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: {
              'x-business-use-case-usage': JSON.stringify({
                '10000000000001': [
                  { call_count: 41, total_cputime: 12, total_time: 9 },
                ],
              }),
            },
          })
      );
      const usage = meter();
      await inbox.listItems(channel, window(), usage);
      expect(usage.usage).toEqual({ percent: 41, regainMinutes: 0 });
    });

    it('leaves usage null without the header', async () => {
      respond(() => json({ data: [] }));
      const usage = meter();
      await inbox.listItems(channel, window(), usage);
      expect(usage.usage).toBeNull();
    });

    it('throws the error of Meta and the unavailable of a network error', async () => {
      respond(() => json({ error: { message: 'x', code: 190 } }, 401));
      await expect(
        inbox.listItems(channel, window(), meter())
      ).rejects.toMatchObject({ details: { status: 401, code: 190 } });

      fetchMock.mockRejectedValue(new Error('fetch failed'));
      await expect(
        inbox.listItems(channel, window(), meter())
      ).rejects.toMatchObject({ details: { unavailable: true } });
    });

    it('throws for a Page id that is not valid, without fetch', async () => {
      await expect(
        inbox.listItems({ ...channel, internalId: '../me' }, window(), meter())
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never writes', async () => {
      respond(() => json({ data: [post(POST, day(1))] }));
      await inbox.listItems(channel, window(), meter());
      for (let i = 0; i < fetchMock.mock.calls.length; i++) {
        expect(call(i).init.method).toBe('GET');
      }
    });
  });

  describe('getConversation (PR 73)', () => {
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const withComments = (
      id: string,
      created: string,
      comments: unknown[],
      paging?: unknown
    ) => ({
      id,
      created_time: created,
      comments: { data: comments, ...(paging ? { paging } : {}) },
    });

    it('gives the thread of a top-level comment: it and its replies, with the post', async () => {
      respond(() =>
        json({
          data: [
            withComments(POST, day(1), [
              {
                id: COMMENT,
                message: 'Oben',
                comments: { data: [{ id: REPLY, message: 'Unten' }] },
              },
              { id: COMMENT_2, comments: { data: [] } },
            ]),
          ],
        })
      );
      const found = await inbox.getConversation(
        channel,
        COMMENT,
        new InboxUsageMeter()
      );
      expect(found?.post).toMatchObject({ id: POST, truncated: false });
      expect(found?.items.map((item) => [item.id, item.parentId])).toEqual([
        [COMMENT, null],
        [REPLY, COMMENT],
      ]);
      expect(found?.items.every((item) => item.postId === POST)).toBe(true);
    });

    it('gives the whole thread when the id is a reply', async () => {
      respond(() =>
        json({
          data: [
            withComments(POST, day(1), [
              { id: COMMENT, comments: { data: [{ id: REPLY }] } },
            ]),
          ],
        })
      );
      const found = await inbox.getConversation(
        channel,
        REPLY,
        new InboxUsageMeter()
      );
      expect(found?.items.map((item) => item.id)).toEqual([COMMENT, REPLY]);
    });

    it('is null for a comment that is not in the window of this channel', async () => {
      respond(() =>
        json({ data: [withComments(POST, day(1), [{ id: COMMENT_2 }])] })
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
    });

    describe('without postId: the window and at least the latest 10 posts (M2)', () => {
      // A page of n posts, all older than the window.
      const oldPosts = (from: number, n: number, comment?: string) =>
        Array.from({ length: n }, (_, i) =>
          withComments(
            `${PAGE}_${300000000000000 + from + i}`,
            day(40 + from + i),
            comment && from + i === 9 ? [{ id: comment }] : []
          )
        );

      it('finds a comment under one of the latest 10 posts that is older than 30 days', async () => {
        respond(() =>
          json({
            data: oldPosts(0, 10, COMMENT),
            paging: { next: 'https://x', cursors: { after: 'MORE' } },
          })
        );
        const found = await inbox.getConversation(
          channel,
          COMMENT,
          new InboxUsageMeter()
        );
        expect(found?.items.map((item) => item.id)).toEqual([COMMENT]);
        expect(found?.post?.id).toBe(`${PAGE}_${300000000000009}`);
      });

      it('does not find a comment under the 11th old post, and reads no further', async () => {
        respond((url) =>
          url.searchParams.get('after') === 'MORE'
            ? json({ data: oldPosts(10, 1, COMMENT) })
            : json({
                data: oldPosts(0, 10),
                paging: { next: 'https://x', cursors: { after: 'MORE' } },
              })
        );
        expect(
          await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
        ).toBeNull();
        // 10 posts read, all older than the window: the end.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it('goes on past 10 posts while the posts are in the window', async () => {
        respond((url) =>
          url.searchParams.get('after') === 'MORE'
            ? json({ data: [withComments(POST_2, day(2), [{ id: COMMENT }])] })
            : json({
                data: Array.from({ length: 10 }, (_, i) =>
                  withComments(`${PAGE}_${300000000000100 + i}`, day(1), [])
                ),
                paging: { next: 'https://x', cursors: { after: 'MORE' } },
              })
        );
        const found = await inbox.getConversation(
          channel,
          COMMENT,
          new InboxUsageMeter()
        );
        expect(found?.post?.id).toBe(POST_2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    it('is null for a comment under no post of the window', async () => {
      respond(() =>
        json({
          data: [withComments(POST_2, day(1), [{ id: COMMENT_2 }])],
        })
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
    });

    it('is null for a comment of a Page that has no posts', async () => {
      respond(() => json({ data: [] }));
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
    });

    it('searches on across pages while the time lasts', async () => {
      respond((url) =>
        url.searchParams.get('after') === 'PAGE2'
          ? json({ data: [withComments(POST_2, day(1), [{ id: COMMENT }])] })
          : json({
              data: [withComments(POST, day(1), [{ id: COMMENT_2 }])],
              paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
            })
      );
      const found = await inbox.getConversation(
        channel,
        COMMENT,
        new InboxUsageMeter()
      );
      expect(found?.post?.id).toBe(POST_2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Starts from the newest post, not from a cursor.
      expect(call(0).url.searchParams.has('after')).toBe(false);
    });

    it('throws InboxOwnershipUnknownError when the time is used up before the end', async () => {
      respond(() => {
        inbox.now += 30_000;
        return json({
          data: [withComments(POST, day(1), [{ id: COMMENT_2 }])],
          paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
        });
      });
      await expect(
        inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(inbox.ownsComment(channel, COMMENT)).rejects.toBeInstanceOf(
        InboxOwnershipUnknownError
      );
    });

    it('ends a search with a cursor that comes again, as not found', async () => {
      respond(() =>
        json({
          data: [withComments(POST, day(1), [{ id: COMMENT_2 }])],
          paging: { next: 'https://x', cursors: { after: 'LOOP' } },
        })
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops at the first hit', async () => {
      respond(() =>
        json({
          data: [withComments(POST, day(1), [{ id: COMMENT }])],
          paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
        })
      );
      await inbox.getConversation(channel, COMMENT, new InboxUsageMeter());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['../me', '1/2', '1.2', '', 'abc'])(
      'is null for the invalid id "%s" without fetch',
      async (id) => {
        expect(
          await inbox.getConversation(channel, id, new InboxUsageMeter())
        ).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('records usage and throws the error of Meta', async () => {
      respond(
        () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: {
              'x-business-use-case-usage': JSON.stringify({
                '1': [{ call_count: 77, estimated_time_to_regain_access: 4 }],
              }),
            },
          })
      );
      const usage = new InboxUsageMeter();
      await inbox.getConversation(channel, COMMENT, usage);
      expect(usage.usage).toEqual({ percent: 77, regainMinutes: 4 });

      respond(() => json({ error: { message: 'x', code: 190 } }, 401));
      await expect(
        inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).rejects.toMatchObject({ details: { status: 401, code: 190 } });
    });
  });

  describe('fromOwner and the budget per page (PR 73)', () => {
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const window = (): InboxWindow => ({
      since: null,
      postsFrom: new Date(NOW - 30 * 86_400_000),
      postsBefore: null,
      cursor: null,
    });

    it('marks what the Page wrote itself, by from.id, in items', async () => {
      respond(() =>
        json({
          data: [
            {
              id: POST,
              created_time: day(1),
              comments: {
                data: [
                  {
                    id: COMMENT,
                    from: { name: FROM_NAME, id: FROM_ID },
                    comments: {
                      data: [
                        { id: REPLY, from: { name: 'Seite', id: PAGE } },
                        { id: `${REPLY}1`, from: { name: 'Anonym' } },
                        { id: `${REPLY}2` },
                      ],
                    },
                  },
                  { id: COMMENT_2, from: { name: 'Seite', id: PAGE } },
                ],
              },
            },
          ],
        })
      );
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(page.items.map((item) => [item.id, item.fromOwner])).toEqual([
        [COMMENT, false],
        [REPLY, true],
        [`${REPLY}1`, false],
        [`${REPLY}2`, false],
        [COMMENT_2, true],
      ]);
      // Only the flag leaves, never an id.
      expect(JSON.stringify(page)).not.toContain(FROM_ID);
    });

    it('marks fromOwner in the demo list (listComments), comment and reply', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [
                {
                  id: COMMENT,
                  from: { name: 'Seite', id: PAGE },
                  comments: {
                    data: [{ id: REPLY, from: { name: 'X', id: FROM_ID } }],
                  },
                },
              ],
            })
      );
      const posts = await inbox.listComments(channel);
      expect(posts[0].comments[0].fromOwner).toBe(true);
      expect(posts[0].comments[0].replies[0].fromOwner).toBe(false);
    });

    it('does not take a similar id for the Page', async () => {
      respond(() =>
        json({
          data: [
            {
              id: POST,
              created_time: day(1),
              comments: {
                data: [
                  { id: COMMENT, from: { id: `${PAGE}0` } },
                  { id: COMMENT_2, from: { id: Number(PAGE) } },
                ],
              },
            },
          ],
        })
      );
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      // A number with the same digits is the same id once turned to a string.
      expect(page.items.map((item) => item.fromOwner)).toEqual([false, true]);
    });

    it('starts the next page only when the time of the last page still fits', async () => {
      // Every call takes 10 s: after 2 pages 20 s + 10 s > 25 s.
      let n = 0;
      respond(() => {
        inbox.now += 10_000;
        n++;
        return json({
          data: [{ id: `${PAGE}_20000000000010${n}`, created_time: day(1) }],
          paging: { next: 'https://x', cursors: { after: `P${n + 1}` } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(page.nextCursor).toBe('P3');
      expect(page.posts).toHaveLength(2);
    });

    it('reads a page that fits: 5 s per page, 25 s budget, then the cursor', async () => {
      let n = 0;
      respond(() => {
        inbox.now += 5_000;
        n++;
        return json({
          data: [{ id: `${PAGE}_20000000000010${n}`, created_time: day(1) }],
          paging: { next: 'https://x', cursors: { after: `P${n + 1}` } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      // elapsed 5,10,15,20,25: the page after the fifth needs 25+5 > 25.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(page.nextCursor).toBe('P6');
    });

    it('always reads the first page, however slow', async () => {
      respond(() => {
        inbox.now += 90_000;
        return json({
          data: [{ id: POST, created_time: day(1) }],
          paging: { next: 'https://x', cursors: { after: 'P2' } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(page.posts).toHaveLength(1);
      expect(page.nextCursor).toBe('P2');
    });

    it('ends on a cursor that comes again and on a page without posts', async () => {
      respond(() =>
        json({
          data: [{ id: POST, created_time: day(1) }],
          paging: { next: 'https://x', cursors: { after: 'SAME' } },
        })
      );
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      respond(() =>
        json({
          data: [],
          paging: { next: 'https://x', cursors: { after: 'EMPTY' } },
        })
      );
      const empty = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(empty).toEqual({ posts: [], items: [], nextCursor: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConversation with postId (PR 73)', () => {
    const FIELDS =
      'id,message,from,created_time,like_count,is_hidden,message_tags';
    const THREAD = `${FIELDS},comments.limit(25){${FIELDS}},parent{id}`;
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const stream = (usage = new InboxUsageMeter()) =>
      inbox.getConversation(channel, COMMENT, usage, POST);

    // The platform for one post: its own record, the stream of its
    // comments (pages by cursor) and the thread of a top-level comment.
    const platform =
      (
        options: {
          post?: unknown;
          pages?: Record<string, unknown>;
          thread?: unknown;
          own?: unknown;
        } = {}
      ) =>
      (url: URL) => {
        const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
        if (path === `/${POST}`) {
          return json(
            options.post ?? {
              id: POST,
              created_time: day(1),
              from: { id: PAGE, name: 'Seite' },
            }
          );
        }
        if (path === `/${POST}/comments`) {
          return json(
            (options.pages ?? {
              first: { data: [{ id: COMMENT }, { id: COMMENT_2 }] },
            })[url.searchParams.get('after') ?? 'first']
          );
        }
        if (path === `/${COMMENT}`) {
          return json(
            options.thread ?? {
              id: COMMENT,
              message: 'Oben',
              from: { id: FROM_ID, name: FROM_NAME },
              comments: { data: [{ id: REPLY, from: { id: PAGE } }] },
            }
          );
        }
        if (path === `/${REPLY}`) {
          return json(options.own ?? { id: REPLY, message: 'Unten' });
        }
        return json({ error: { message: 'unexpected', code: 1 } }, 400);
      };

    it('checks the post, searches it and reads the thread, GET only', async () => {
      respond(platform());
      const found = await stream();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(0).url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${POST}`);
      expect(call(0).url.searchParams.get('fields')).toBe(
        'id,permalink_url,created_time,status_type,from'
      );
      const { url } = call(1);
      expect(url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${POST}/comments`);
      expect(url.searchParams.get('filter')).toBe('stream');
      expect(url.searchParams.get('order')).toBe('reverse_chronological');
      expect(url.searchParams.get('fields')).toBe('id,parent{id}');
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.has('after')).toBe(false);
      expect(call(2).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(call(2).url.searchParams.get('fields')).toBe(THREAD);
      for (let i = 0; i < 3; i++) {
        expect(call(i).init.method).toBe('GET');
      }

      expect(found?.post).toMatchObject({ id: POST, commentsCount: null });
      expect(
        found?.items.map((item) => [item.id, item.parentId, item.postId])
      ).toEqual([
        [COMMENT, null, POST],
        [REPLY, COMMENT, POST],
      ]);
      expect(found?.items.map((item) => item.fromOwner)).toEqual([false, true]);
      expect(JSON.stringify(found)).not.toContain(FROM_ID);
    });

    it('does not read the published_posts of the Page', async () => {
      respond(platform());
      await stream();
      for (let i = 0; i < fetchMock.mock.calls.length; i++) {
        expect(call(i).url.pathname).not.toContain('published_posts');
      }
    });

    it('finds a reply through parent and gives the thread of its top-level comment', async () => {
      respond(
        platform({
          pages: { first: { data: [{ id: REPLY, parent: { id: COMMENT } }] } },
        })
      );
      const found = await inbox.getConversation(
        channel,
        REPLY,
        new InboxUsageMeter(),
        POST
      );
      expect(call(2).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(found?.items.map((item) => item.id)).toEqual([COMMENT, REPLY]);
    });

    it('searches across the pages of the stream with after', async () => {
      respond(
        platform({
          pages: {
            first: {
              data: [{ id: COMMENT_2 }],
              paging: { next: 'https://x', cursors: { after: 'P2' } },
            },
            P2: { data: [{ id: COMMENT }] },
          },
        })
      );
      expect(await stream()).not.toBeNull();
      expect(call(2).url.searchParams.get('after')).toBe('P2');
    });

    it('is null for a comment that is not under the post, without a thread read', async () => {
      respond(platform({ pages: { first: { data: [{ id: COMMENT_2 }] } } }));
      expect(await stream()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('is null without a fetch for a post of another Page and for an invalid postId', async () => {
      for (const postId of [
        `100000000000999_200000000000001`,
        `${PAGE}`,
        '../me',
        '1/2',
        'abc',
        `${PAGE}_`,
      ]) {
        expect(
          await inbox.getConversation(
            channel,
            COMMENT,
            new InboxUsageMeter(),
            postId
          )
        ).toBeNull();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is null when the post is not from the Page, or the post answers another id', async () => {
      respond(
        platform({ post: { id: POST, from: { id: '100000000000999' } } })
      );
      expect(await stream()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      respond(platform({ post: { id: POST } }));
      expect(await stream()).toBeNull();

      fetchMock.mockReset();
      respond(
        platform({
          post: { id: `${PAGE}_200000000000777`, from: { id: PAGE } },
        })
      );
      expect(await stream()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('is null for a post that does not exist (code 100, subcode 33) and throws other errors', async () => {
      respond(() =>
        json({ error: { message: 'x', code: 100, error_subcode: 33 } }, 400)
      );
      expect(await stream()).toBeNull();

      respond(() => json({ error: { message: 'x', code: 190 } }, 401));
      await expect(stream()).rejects.toMatchObject({
        details: { status: 401, code: 190 },
      });
    });

    it('throws InboxOwnershipUnknownError when the budget ends between pages, no thread read', async () => {
      const handler = platform({
        pages: {
          first: {
            data: [{ id: COMMENT_2 }],
            paging: { next: 'https://x', cursors: { after: 'P2' } },
          },
          P2: { data: [{ id: COMMENT }] },
        },
      });
      respond((url, init) => {
        // The stream page takes 30 s.
        if (url.pathname.endsWith('/comments')) {
          inbox.now += 30_000;
        }
        return handler(url);
      });
      await expect(stream()).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.every(
          ([, init]: any) => (init as any).method === 'GET'
        )
      ).toBe(true);
    });

    it('reads the first page of the stream however slow', async () => {
      const handler = platform();
      respond((url) => {
        inbox.now += 90_000;
        return handler(url);
      });
      expect(await stream()).not.toBeNull();
    });

    it('is null for a cursor that comes again, and for an empty page', async () => {
      respond(
        platform({
          pages: {
            first: {
              data: [{ id: COMMENT_2 }],
              paging: { next: 'https://x', cursors: { after: 'SAME' } },
            },
            SAME: {
              data: [{ id: COMMENT_2 }],
              paging: { next: 'https://x', cursors: { after: 'SAME' } },
            },
          },
        })
      );
      expect(await stream()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      fetchMock.mockReset();
      respond(
        platform({
          pages: {
            first: {
              data: [],
              paging: { next: 'https://x', cursors: { after: 'E' } },
            },
          },
        })
      );
      expect(await stream()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('adds a reply that is not in the replies of its thread, read on its own', async () => {
      respond(
        platform({
          pages: { first: { data: [{ id: REPLY, parent: { id: COMMENT } }] } },
          thread: { id: COMMENT, comments: { data: [] } },
        })
      );
      const found = await inbox.getConversation(
        channel,
        REPLY,
        new InboxUsageMeter(),
        POST
      );
      expect(call(3).url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${REPLY}`);
      expect(call(3).url.searchParams.get('fields')).toBe(FIELDS);
      expect(found?.items.map((item) => [item.id, item.parentId])).toEqual([
        [COMMENT, null],
        [REPLY, COMMENT],
      ]);
    });

    it('reads the newest replies of a thread with more pages', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}/comments`)
          ? json({ data: [{ id: REPLY }] })
          : platform({
              thread: {
                id: COMMENT,
                comments: { data: [], paging: { next: 'https://x' } },
              },
            })(url)
      );
      const found = await stream();
      const read = fetchMock.mock.calls
        .map((_, i) => call(i))
        .find((c) => c.url.pathname.endsWith(`/${COMMENT}/comments`));
      expect(read?.url.searchParams.get('order')).toBe('reverse_chronological');
      expect(read?.url.searchParams.get('limit')).toBe('25');
      expect(found?.items.map((item) => item.id)).toEqual([COMMENT, REPLY]);
    });

    it('is null when the thread has no valid id', async () => {
      respond(platform({ thread: { id: '../x' } }));
      expect(await stream()).toBeNull();
    });

    it('records usage of every call', async () => {
      const handler = platform();
      respond(async (url) => {
        const res = handler(url);
        return new Response(JSON.stringify(await res.json()), {
          status: 200,
          headers: {
            'x-business-use-case-usage': JSON.stringify({
              '1': [{ call_count: 44 }],
            }),
          },
        });
      });
      const usage = new InboxUsageMeter();
      await stream(usage);
      expect(usage.usage).toEqual({ percent: 44, regainMinutes: 0 });
    });

    it('counts the budget from the start, the read of the post included', async () => {
      const handler = platform({
        pages: {
          first: {
            data: [{ id: COMMENT_2 }],
            paging: { next: 'https://x', cursors: { after: 'P2' } },
          },
          P2: { data: [{ id: COMMENT }] },
        },
      });
      respond((url) => {
        // 20 s for the post, 10 s for the page: 30 + 10 > 25 s.
        inbox.now += url.pathname.endsWith('/comments') ? 10_000 : 20_000;
        return handler(url);
      });
      await expect(stream()).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('goes up from a comment that has a parent, at most two steps', async () => {
      const ROOT = '200000000000001_300000000000100';
      const MID = '200000000000001_300000000000101';
      const TOP = '200000000000001_300000000000102';
      respond((url) => {
        const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
        if (path === `/${POST}`) {
          return json({ id: POST, from: { id: PAGE } });
        }
        if (path === `/${POST}/comments`) {
          return json({ data: [{ id: COMMENT, parent: { id: MID } }] });
        }
        const parents: Record<string, string> = {
          [MID]: ROOT,
          [ROOT]: TOP,
        };
        const id = path.slice(1);
        return json({
          id,
          comments: { data: [] },
          ...(parents[id] ? { parent: { id: parents[id] } } : {}),
        });
      });
      const found = await inbox.getConversation(
        channel,
        COMMENT,
        new InboxUsageMeter(),
        POST
      );
      const reads = fetchMock.mock.calls
        .map((_, i) => call(i))
        .map((c) => c.url.pathname.replace(`/${META_GRAPH_API_VERSION}/`, ''));
      // post, stream, MID (the parent found), then two steps up (ROOT, TOP)
      // and it stops. The reply is not in the thread: read on its own.
      expect(reads).toEqual([
        POST,
        `${POST}/comments`,
        MID,
        ROOT,
        TOP,
        COMMENT,
      ]);
      expect(found?.items.map((item) => [item.id, item.parentId])).toEqual([
        [TOP, null],
        [COMMENT, TOP],
      ]);
    });

    it('does not go up from a top-level comment: one thread read', async () => {
      respond(platform());
      await stream();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ownsComment with postId makes no call after the find: the post and the stream only', async () => {
      respond(platform());
      expect(await inbox.ownsComment(channel, COMMENT, POST)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0).url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${POST}`);
      expect(call(1).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${POST}/comments`
      );

      // A reply is found the same way, without a thread read.
      fetchMock.mockReset();
      respond(
        platform({
          pages: { first: { data: [{ id: REPLY, parent: { id: COMMENT } }] } },
        })
      );
      expect(await inbox.ownsComment(channel, REPLY, POST)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ownsComment with postId is false without a fetch for an invalid comment id', async () => {
      expect(await inbox.ownsComment(channel, '../x', POST)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ownsComment without postId still uses the search of the window', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({
              data: [
                {
                  id: POST,
                  created_time: day(1),
                  comments: { data: [{ id: COMMENT }] },
                },
              ],
            })
          : json({ data: [] })
      );
      expect(await inbox.ownsComment(channel, COMMENT)).toBe(true);
      expect(call(0).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${PAGE}/published_posts`
      );
    });

    it('ownsComment with postId is true for the comment under the post and false otherwise', async () => {
      respond(platform());
      expect(await inbox.ownsComment(channel, COMMENT, POST)).toBe(true);

      fetchMock.mockReset();
      respond(platform({ pages: { first: { data: [] } } }));
      expect(await inbox.ownsComment(channel, COMMENT, POST)).toBe(false);

      fetchMock.mockReset();
      expect(
        await inbox.ownsComment(channel, COMMENT, `100000000000999_2`)
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ownsComment throws the ownership error on a budget end', async () => {
      const handler = platform({
        pages: {
          first: {
            data: [{ id: COMMENT_2 }],
            paging: { next: 'https://x', cursors: { after: 'P2' } },
          },
        },
      });
      respond((url) => {
        if (url.pathname.endsWith('/comments')) {
          inbox.now += 30_000;
        }
        return handler(url);
      });
      await expect(
        inbox.ownsComment(channel, COMMENT, POST)
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
    });
  });

  describe('mentions (W76)', () => {
    const FIELDS =
      'id,message,from,created_time,like_count,is_hidden,message_tags';
    const PERSON = 'Erika Beispiel';
    const SIDE = 'Beispiel Werkstatt';
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const window = (): InboxWindow => ({
      since: null,
      postsFrom: new Date(NOW - 30 * 86_400_000),
      postsBefore: null,
      cursor: null,
    });
    const tags = [
      {
        id: '600000000000001',
        name: PERSON,
        type: 'user',
        offset: 0,
        length: 14,
      },
      {
        id: '600000000000002',
        name: SIDE,
        type: 'page',
        offset: 20,
        length: 18,
      },
    ];
    const feedWith = (comment: Record<string, unknown>) => () =>
      json({
        data: [
          { id: POST, created_time: day(1), comments: { data: [comment] } },
        ],
      });

    it('maps message_tags of a person and a Page to their names, no id, offset or type', async () => {
      respond(feedWith({ id: COMMENT, message_tags: tags }));
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(page.items[0].mentions).toEqual([PERSON, SIDE]);
      const text = JSON.stringify(page);
      expect(text).not.toContain('600000000000001');
      expect(text).not.toContain('600000000000002');
      expect(text).not.toContain('offset');
      expect(text).not.toContain('"type"');
      expect(text).not.toContain('message_tags');
    });

    it('gives the replies their own mentions', async () => {
      respond(
        feedWith({
          id: COMMENT,
          message_tags: [tags[0]],
          comments: {
            data: [{ id: REPLY, message_tags: [tags[1]] }, { id: `${REPLY}1` }],
          },
        })
      );
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(page.items.map((item) => [item.id, item.mentions])).toEqual([
        [COMMENT, [PERSON]],
        [REPLY, [SIDE]],
        [`${REPLY}1`, []],
      ]);
    });

    it('gives mentions [] for a missing message_tags, a non-array and entries without a name', async () => {
      const cases: unknown[] = [
        undefined,
        null,
        'Erika Beispiel',
        { name: PERSON },
        7,
        [],
        [
          { id: '1' },
          { name: null },
          { name: 5 },
          { name: '  ' },
          null,
          'x',
          {},
        ],
      ];
      for (const message_tags of cases) {
        respond(feedWith({ id: COMMENT, message_tags }));
        const page = await inbox.listItems(
          channel,
          window(),
          new InboxUsageMeter()
        );
        expect(page.items[0].mentions).toEqual([]);
      }
    });

    it('keeps the names of valid entries next to broken ones, without doubles', async () => {
      respond(
        feedWith({
          id: COMMENT,
          message_tags: [
            { id: '1' },
            { name: ` ${PERSON} ` },
            { name: PERSON },
            null,
          ],
        })
      );
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(page.items[0].mentions).toEqual([PERSON]);
    });

    it('carries mentions in the demo list (listComments), comment and reply', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [
                {
                  id: COMMENT,
                  message_tags: [tags[0]],
                  comments: { data: [{ id: REPLY, message_tags: [tags[1]] }] },
                },
              ],
            })
      );
      const posts = await inbox.listComments(channel);
      expect(posts[0].comments[0].mentions).toEqual([PERSON]);
      expect(posts[0].comments[0].replies[0].mentions).toEqual([SIDE]);
      expect(JSON.stringify(posts)).not.toContain('600000000000001');
    });

    describe('the tagged part of the text (taggedPart)', () => {
      const FULL = 'Max Muster';
      const mentionsOf = async (comment: Record<string, unknown>) => {
        respond(feedWith({ id: COMMENT, ...comment }));
        const page = await inbox.listItems(
          channel,
          window(),
          new InboxUsageMeter()
        );
        return page.items[0].mentions;
      };
      const tag = (extra: Record<string, unknown>) => ({
        id: '600000000000003',
        name: FULL,
        type: 'user',
        ...extra,
      });

      it('gives a tag shortened to the first name as name and part', async () => {
        expect(
          await mentionsOf({
            message: 'Danke Max, super!',
            message_tags: [tag({ offset: 6, length: 3 })],
          })
        ).toEqual([FULL, 'Max']);
      });

      it('lists a part equal to the name once', async () => {
        expect(
          await mentionsOf({
            message: 'Danke Max Muster!',
            message_tags: [tag({ offset: 6, length: 10 })],
          })
        ).toEqual([FULL]);
      });

      it('counts the offset in UTF-16 units after an emoji', async () => {
        const message = '😀 Danke Max!';
        expect(message.indexOf('Max')).toBe(9);
        expect(
          await mentionsOf({
            message,
            message_tags: [tag({ offset: 9, length: 3 })],
          })
        ).toEqual([FULL, 'Max']);
      });

      it('drops a part that splits a surrogate pair, keeps the name', async () => {
        for (const [offset, length] of [
          [1, 3], // starts on a low surrogate
          [0, 1], // ends on a high surrogate
        ]) {
          expect(
            await mentionsOf({
              message: '😀 Danke Max!',
              message_tags: [tag({ offset, length })],
            })
          ).toEqual([FULL]);
        }
      });

      it('keeps a part that is a whole emoji pair', async () => {
        expect(
          await mentionsOf({
            message: '😀 Danke Max!',
            message_tags: [tag({ offset: 0, length: 2 })],
          })
        ).toEqual([FULL, '😀']);
      });

      it('drops a part outside the text, negative, empty or not an integer', async () => {
        const message = 'Danke Max!';
        const cases: [unknown, unknown][] = [
          [6, 50],
          [6, 5],
          [10, 1],
          [11, 1],
          [-1, 3],
          [6, 0],
          [6, -3],
          [6.5, 3],
          [6, 1.5],
          ['6', 3],
          [6, '3'],
          [NaN, 3],
          [6, NaN],
          [Infinity, 3],
          [6, Infinity],
          [null, 3],
          [6, undefined],
          [true, 1],
        ];
        for (const [offset, length] of cases) {
          expect(
            await mentionsOf({
              message,
              message_tags: [tag({ offset, length })],
            })
          ).toEqual([FULL]);
        }
      });

      it('drops the part of a comment without a message', async () => {
        expect(
          await mentionsOf({ message_tags: [tag({ offset: 0, length: 3 })] })
        ).toEqual([FULL]);
        expect(
          await mentionsOf({
            message: 7,
            message_tags: [tag({ offset: 0, length: 1 })],
          })
        ).toEqual([FULL]);
      });

      it('keeps only the part of a tag without a name', async () => {
        expect(
          await mentionsOf({
            message: 'Danke Max!',
            message_tags: [{ id: '1', offset: 6, length: 3 }],
          })
        ).toEqual(['Max']);
      });

      it('orders name 1, part 1, name 2, part 2', async () => {
        expect(
          await mentionsOf({
            message: 'Max und Lena sind da',
            message_tags: [
              tag({ offset: 0, length: 3 }),
              tag({ name: 'Lena Beispiel', offset: 8, length: 4 }),
            ],
          })
        ).toEqual([FULL, 'Max', 'Lena Beispiel', 'Lena']);
      });

      it('trims the part and drops one of only spaces', async () => {
        expect(
          await mentionsOf({
            message: 'Danke  Max !',
            message_tags: [
              tag({ offset: 5, length: 6 }),
              tag({ name: 'Lena Beispiel', offset: 5, length: 2 }),
            ],
          })
        ).toEqual([FULL, 'Max', 'Lena Beispiel']);
      });

      it('cuts the part to 300 characters', async () => {
        const message = 'a'.repeat(400);
        const [, part] = await mentionsOf({
          message,
          message_tags: [tag({ offset: 0, length: 400 })],
        });
        expect(part).toBe('a'.repeat(300));
      });

      it('counts names and parts together towards the limit of 50', async () => {
        const message = Array.from({ length: 40 }, (_, i) => `W${i}`).join(' ');
        const message_tags = Array.from({ length: 40 }, (_, i) => {
          const offset = message.indexOf(`W${i}`);
          return tag({
            name: `Name ${i} voll`,
            offset,
            length: `W${i}`.length,
          });
        });
        const mentions = await mentionsOf({ message, message_tags });
        expect(mentions).toHaveLength(50);
        expect(mentions.slice(0, 4)).toEqual([
          'Name 0 voll',
          'W0',
          'Name 1 voll',
          'W1',
        ]);
        expect(mentions[49]).toBe('W24');
      });

      it('takes the own text for the part in replies', async () => {
        respond(
          feedWith({
            id: COMMENT,
            message: 'Hallo Max',
            message_tags: [tag({ offset: 6, length: 3 })],
            comments: {
              data: [
                {
                  id: REPLY,
                  message: 'Nein, Lena!',
                  message_tags: [
                    tag({ name: 'Lena Beispiel', offset: 6, length: 4 }),
                  ],
                },
              ],
            },
          })
        );
        const page = await inbox.listItems(
          channel,
          window(),
          new InboxUsageMeter()
        );
        expect(page.items.map((item) => [item.id, item.mentions])).toEqual([
          [COMMENT, [FULL, 'Max']],
          [REPLY, ['Lena Beispiel', 'Lena']],
        ]);
      });

      it('takes the own text in the demo list too', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({ data: [{ id: POST }] })
            : json({
                data: [
                  {
                    id: COMMENT,
                    message: 'Hallo Max',
                    message_tags: [tag({ offset: 6, length: 3 })],
                    comments: {
                      data: [
                        {
                          id: REPLY,
                          message: 'Ja Lena',
                          message_tags: [
                            tag({
                              name: 'Lena Beispiel',
                              offset: 3,
                              length: 4,
                            }),
                          ],
                        },
                      ],
                    },
                  },
                ],
              })
        );
        const posts = await inbox.listComments(channel);
        expect(posts[0].comments[0].mentions).toEqual([FULL, 'Max']);
        expect(posts[0].comments[0].replies[0].mentions).toEqual([
          'Lena Beispiel',
          'Lena',
        ]);
      });
    });

    describe('message_tags in the fields of every read of comments', () => {
      const fieldsOf = () =>
        fetchMock.mock.calls.map(([url]) => ({
          path: new URL(url as string).pathname,
          fields: new URL(url as string).searchParams.get('fields') ?? '',
        }));

      it('window (items): comments and replies embedded', async () => {
        respond(() => json({ data: [] }));
        await inbox.listItems(channel, window(), new InboxUsageMeter());
        const fields = fieldsOf()[0].fields;
        expect(fields).toContain(
          `comments.limit(50){${FIELDS},comments.limit(25){${FIELDS}}}`
        );
      });

      it('demo list: the thread of the comments of a post', async () => {
        respond((url) =>
          url.pathname.endsWith('/published_posts')
            ? json({ data: [{ id: POST }] })
            : json({ data: [] })
        );
        await inbox.listComments(channel);
        expect(fieldsOf()[1].fields).toBe(
          `${FIELDS},comments.limit(25){${FIELDS}}`
        );
      });

      it('thread of a comment (getConversation with postId)', async () => {
        respond((url) => {
          const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
          if (path === `/${POST}`) {
            return json({ id: POST, created_time: day(1), from: { id: PAGE } });
          }
          if (path === `/${POST}/comments`) {
            return json({ data: [{ id: COMMENT }] });
          }
          return json({ id: COMMENT, comments: { data: [{ id: REPLY }] } });
        });
        await inbox.getConversation(
          channel,
          COMMENT,
          new InboxUsageMeter(),
          POST
        );
        const read = fieldsOf().find((c) => c.path.endsWith(`/${COMMENT}`));
        expect(read?.fields).toBe(
          `${FIELDS},comments.limit(25){${FIELDS}},parent{id}`
        );
      });

      it('a single comment that is in none of the pages of its thread', async () => {
        respond((url) => {
          const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
          if (path === `/${POST}`) {
            return json({ id: POST, created_time: day(1), from: { id: PAGE } });
          }
          if (path === `/${POST}/comments`) {
            return json({
              data: [{ id: COMMENT }, { id: REPLY, parent: { id: COMMENT } }],
            });
          }
          if (path === `/${COMMENT}`) {
            return json({ id: COMMENT, comments: { data: [] } });
          }
          return json({ id: REPLY, message_tags: [tags[0]] });
        });
        const found = await inbox.getConversation(
          channel,
          REPLY,
          new InboxUsageMeter(),
          POST
        );
        const read = fieldsOf().find((c) => c.path.endsWith(`/${REPLY}`));
        expect(read?.fields).toBe(FIELDS);
        expect(
          found?.items.find((item) => item.id === REPLY)?.mentions
        ).toEqual([PERSON]);
      });

      it('replies of a comment with more than one page', async () => {
        respond((url) => {
          if (url.pathname.endsWith('/published_posts')) {
            return json({
              data: [
                {
                  id: POST,
                  created_time: day(1),
                  comments: {
                    data: [
                      {
                        id: COMMENT,
                        comments: { data: [], paging: { next: 'https://x' } },
                      },
                    ],
                  },
                },
              ],
            });
          }
          return json({ data: [{ id: REPLY, message_tags: [tags[1]] }] });
        });
        const page = await inbox.listItems(
          channel,
          window(),
          new InboxUsageMeter()
        );
        expect(fieldsOf()[1].path).toContain(`/${COMMENT}/comments`);
        expect(fieldsOf()[1].fields).toBe(FIELDS);
        expect(page.items.find((item) => item.id === REPLY)?.mentions).toEqual([
          SIDE,
        ]);
      });
    });
  });

  describe('replies in blocks of 5 (PR 73)', () => {
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `200000000000001_3000000000002${String(i).padStart(2, '0')}`,
        comments: { data: [], paging: { next: 'https://x' } },
      }));
    it('listItems reads at most 5 reply threads at once, and all of them', async () => {
      const state = { inFlight: 0, max: 0, reads: 0 };
      respond(async (url) => {
        if (url.pathname.endsWith('/published_posts')) {
          return json({
            data: [
              { id: POST, created_time: day(1), comments: { data: many(12) } },
            ],
          });
        }
        state.inFlight++;
        state.reads++;
        state.max = Math.max(state.max, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.inFlight--;
        return json({ data: [] });
      });
      await inbox.listItems(
        channel,
        {
          since: null,
          postsFrom: new Date(NOW - 30 * 86_400_000),
          postsBefore: null,
          cursor: null,
        },
        new InboxUsageMeter()
      );
      expect(state.reads).toBe(12);
      expect(state.max).toBeGreaterThan(1);
      expect(state.max).toBeLessThanOrEqual(5);
    });

    it('listComments (the demo) reads the newest replies of a long thread, in blocks of 5', async () => {
      const state = { inFlight: 0, max: 0, reads: 0 };
      const NEWEST = '300000000000001_400000000000777';
      respond(async (url) => {
        if (url.pathname.endsWith('/published_posts')) {
          return json({ data: [{ id: POST }] });
        }
        if (url.pathname.endsWith(`/${POST}/comments`)) {
          return json({ data: many(7), summary: { total_count: 7 } });
        }
        state.inFlight++;
        state.reads++;
        state.max = Math.max(state.max, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.inFlight--;
        expect(url.searchParams.get('order')).toBe('reverse_chronological');
        expect(url.searchParams.get('limit')).toBe('25');
        return json({ data: [{ id: NEWEST }] });
      });
      const posts = await inbox.listComments(channel);
      expect(state.reads).toBe(7);
      expect(state.max).toBeLessThanOrEqual(5);
      expect(posts[0].comments).toHaveLength(7);
      expect(posts[0].comments.every((c) => c.replies[0].id === NEWEST)).toBe(
        true
      );
    });

    it('listComments makes no reply read for a thread that fits', async () => {
      respond((url) =>
        url.pathname.endsWith('/published_posts')
          ? json({ data: [{ id: POST }] })
          : json({
              data: [{ id: COMMENT, comments: { data: [{ id: REPLY }] } }],
            })
      );
      await inbox.listComments(channel);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('like (PR 73)', () => {
    it('likes with one POST to /{comment}/likes, the token in the body', async () => {
      respond(() => json({ success: true }));
      await expect(inbox.like(channel, COMMENT, true)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { raw, init } = call();
      expect(raw).toBe(`${GRAPH}/${COMMENT}/likes`);
      expect(init.method).toBe('POST');
      expect([...bodyOf().keys()]).toEqual(['access_token']);
      expect(bodyOf().get('access_token')).toBe(pageToken);
      expect(raw).not.toContain(pageToken);
    });

    it('takes the like back with one DELETE to /{comment}/likes', async () => {
      respond(() => json({ success: true }));
      await inbox.like(channel, REPLY, false);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = call();
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${REPLY}/likes`);
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();
      expect([...url.searchParams.keys()]).toEqual(['access_token']);
    });

    it('throws when Meta does not confirm with success: true', async () => {
      for (const body of [{ success: false }, {}, { id: COMMENT }]) {
        respond(() => json(body));
        await expect(inbox.like(channel, COMMENT, true)).rejects.toMatchObject({
          details: { status: 200 },
        });
      }
    });

    it('throws the error of Meta', async () => {
      respond(() => json({ error: { message: 'x', code: 200 } }, 403));
      await expect(inbox.like(channel, COMMENT, true)).rejects.toMatchObject({
        details: { status: 403, code: 200 },
      });
    });

    it('is no known outcome on a network error', async () => {
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      await expect(inbox.like(channel, COMMENT, true)).rejects.toMatchObject({
        details: { unavailable: true },
      });
    });

    it('does not call fetch for an invalid id', async () => {
      for (const id of ['../me', '1/2', '1.2', '', 'abc']) {
        await expect(inbox.like(channel, id, true)).rejects.toThrow(
          'invalid platform id'
        );
        await expect(inbox.like(channel, id, false)).rejects.toThrow(
          'invalid platform id'
        );
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('capabilities (PR 73)', () => {
    it('allows reply, hide, delete and like, but no realtime yet', () => {
      expect(inbox.capabilities).toEqual({
        reply: true,
        hide: true,
        delete: true,
        like: true,
        realtime: false,
      });
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
