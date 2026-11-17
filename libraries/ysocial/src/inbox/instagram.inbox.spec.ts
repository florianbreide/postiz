import { randomBytes } from 'crypto';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import {
  InboxPlatformError,
  InboxUsageMeter,
  InboxWindow,
} from './inbox.rules';
import { InstagramInbox } from './instagram.inbox';
import { YsocialInboxProvider } from './inbox.rules';

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

// Fixed wall clock: the window is the 30 days before it.
const NOW = Date.parse('2026-11-17T12:00:00Z');

class TestInstagramInbox extends InstagramInbox {
  now = NOW;
  protected clock = () => this.now;
}

describe('InstagramInbox', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;
  let inbox: TestInstagramInbox;

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
    inbox = new TestInstagramInbox();
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
        'id,text,timestamp,username,like_count,hidden,user,replies{id,text,timestamp,username,like_count,hidden,user}'
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
              fromOwner: false,
              replies: [
                {
                  id: REPLY,
                  text: 'Erfundene Antwort',
                  username: 'konto',
                  timestamp: '2026-11-02T11:00:00+0000',
                  likeCount: 1,
                  hidden: false,
                  fromOwner: false,
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
              fromOwner: false,
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
      expect(call(1).url.searchParams.get('fields')).toBe('owner');
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

  describe('listItems (PR 73)', () => {
    const FIELDS = 'id,text,timestamp,username,like_count,hidden,user';
    const MEDIA_3 = '17900000000000003';
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
    const media = (id: string, created: string, comments = 0) => ({
      id,
      permalink: 'https://www.instagram.com/p/ERFUNDEN/',
      timestamp: created,
      media_type: 'IMAGE',
      comments_count: comments,
    });
    const comment = (id: string, created: string, replies: unknown[] = []) => ({
      id,
      text: 'Erfundener Text',
      username: 'erfundene_person',
      timestamp: created,
      like_count: 2,
      hidden: false,
      replies: { data: replies },
    });
    // The list of media, comments by media id.
    const platform =
      (
        list: unknown,
        comments: Record<string, unknown> = {},
        listFor: (after: string | null) => unknown = () => list
      ) =>
      (url: URL) => {
        if (url.pathname.endsWith(`/${IG}/media`)) {
          return json(listFor(url.searchParams.get('after')));
        }
        const id = url.pathname.split('/').slice(-2)[0];
        return json(comments[id] ?? { data: [] });
      };

    it('reads the media with the cursor as after, 10 per page', async () => {
      respond(() => json({ data: [] }));
      expect(await inbox.listItems(channel, window(), meter())).toEqual({
        posts: [],
        items: [],
        nextCursor: null,
      });
      const { url, init } = call();
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${IG}/media`);
      expect(init.method).toBe('GET');
      expect(url.searchParams.get('fields')).toBe(
        'id,permalink,timestamp,media_type,comments_count'
      );
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.has('after')).toBe(false);

      await inbox.listItems(channel, window({ cursor: 'QVFIUk1_-=' }), meter());
      expect(call(1).url.searchParams.get('after')).toBe('QVFIUk1_-=');
    });

    it('reads the comments of one media with replies, 50 per page', async () => {
      respond(
        platform(
          { data: [media(MEDIA, day(1), 2)] },
          { [MEDIA]: { data: [comment(COMMENT, day(1))] } }
        )
      );
      await inbox.listItems(channel, window(), meter());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url, init } = call(1);
      expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH}/${MEDIA}/comments`);
      expect(init.method).toBe('GET');
      expect(url.searchParams.get('fields')).toBe(
        `${FIELDS},replies{${FIELDS}}`
      );
      expect(url.searchParams.get('limit')).toBe('50');
    });

    it('makes no comment call for a media with comments_count 0', async () => {
      respond(
        platform({ data: [media(MEDIA, day(1), 0), media(MEDIA_2, day(2))] })
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA, MEDIA_2]);
      expect(page.posts[0]).toMatchObject({
        commentsCount: 0,
        truncated: false,
      });
      expect(page.items).toEqual([]);
    });

    it('maps posts and flat items with postId and parentId', async () => {
      respond(
        platform(
          { data: [media(MEDIA, day(1), 2)] },
          {
            [MEDIA]: {
              data: [
                comment(COMMENT, day(1), [
                  { id: REPLY, text: 'Antwort', timestamp: day(1) },
                ]),
              ],
            },
          }
        )
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts).toEqual([
        {
          id: MEDIA,
          permalink: 'https://www.instagram.com/p/ERFUNDEN/',
          timestamp: day(1),
          mediaType: 'IMAGE',
          commentsCount: 2,
          truncated: false,
        },
      ]);
      expect(page.items).toEqual([
        {
          id: COMMENT,
          postId: MEDIA,
          parentId: null,
          text: 'Erfundener Text',
          username: 'erfundene_person',
          timestamp: day(1),
          likeCount: 2,
          hidden: false,
          fromOwner: false,
        },
        expect.objectContaining({
          id: REPLY,
          postId: MEDIA,
          parentId: COMMENT,
        }),
      ]);
    });

    it('keeps only comments and replies at or after since', async () => {
      respond(
        platform(
          { data: [media(MEDIA, day(5), 3)] },
          {
            [MEDIA]: {
              data: [
                comment(COMMENT, day(4), [{ id: REPLY, timestamp: day(1) }]),
                comment(COMMENT_2, day(2)),
              ],
            },
          }
        )
      );
      const page = await inbox.listItems(
        channel,
        window({ since: new Date(day(2)) }),
        meter()
      );
      expect(page.items.map((item) => item.id)).toEqual([REPLY, COMMENT_2]);
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA]);
    });

    it('ends at the first media older than postsFrom, no more reads, no cursor', async () => {
      respond(
        platform(
          {
            data: [
              media(MEDIA, day(2), 1),
              media(MEDIA_2, day(31), 1),
              media(MEDIA_3, day(1), 1),
            ],
            paging: { next: 'https://x', cursors: { after: 'MORE' } },
          },
          { [MEDIA]: { data: [comment(COMMENT, day(2))] } }
        )
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA]);
      expect(page.nextCursor).toBeNull();
      // The list and the one comment call, nothing for the old media.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('with olderThan skips newer media and has no lower bound', async () => {
      respond(
        platform({
          data: [
            media(MEDIA, day(2)),
            media(MEDIA_2, day(40)),
            media(MEDIA_3, day(90)),
          ],
        })
      );
      const page = await inbox.listItems(
        channel,
        window({ postsFrom: null, postsBefore: new Date(day(10)) }),
        meter()
      );
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA_2, MEDIA_3]);
    });

    it('reads the next page with after while the budget lasts, then null', async () => {
      respond(
        platform(null, {}, (after) =>
          after === 'PAGE2'
            ? { data: [media(MEDIA_2, day(2))] }
            : {
                data: [media(MEDIA, day(1))],
                paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
              }
        )
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA, MEDIA_2]);
      expect(page.nextCursor).toBeNull();
      expect(call(1).url.searchParams.get('after')).toBe('PAGE2');
    });

    it('stops after the budget of 25 s and gives nextCursor', async () => {
      respond((url) => {
        inbox.now += 30_000;
        return platform({
          data: [media(MEDIA, day(1))],
          paging: { next: 'https://x', cursors: { after: 'PAGE2' } },
        })(url);
      });
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.nextCursor).toBe('PAGE2');
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA]);
    });

    it('does not stop for the budget on the last page: nextCursor null', async () => {
      respond((url) => {
        inbox.now += 30_000;
        return platform({ data: [media(MEDIA, day(1))] })(url);
      });
      expect(
        (await inbox.listItems(channel, window(), meter())).nextCursor
      ).toBeNull();
    });

    it('marks the media truncated when comments or replies have more pages', async () => {
      respond(
        platform(
          {
            data: [
              media(MEDIA, day(1), 80),
              media(MEDIA_2, day(2), 5),
              media(MEDIA_3, day(3), 5),
            ],
          },
          {
            [MEDIA]: {
              data: [comment(COMMENT, day(1))],
              paging: { next: 'https://x' },
            },
            [MEDIA_2]: {
              data: [
                {
                  ...comment(COMMENT_2, day(2)),
                  replies: { data: [], paging: { next: 'https://y' } },
                },
              ],
            },
            [MEDIA_3]: { data: [comment(COMMENT, day(3))] },
          }
        )
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.truncated)).toEqual([true, true, false]);
    });

    it('drops entries with an invalid id', async () => {
      respond(
        platform(
          { data: [media(MEDIA, day(1), 2), media('../me', day(1), 1)] },
          {
            [MEDIA]: {
              data: [
                comment('a.b', day(1)),
                comment(COMMENT, day(1), [{ id: '../x', timestamp: day(1) }]),
              ],
            },
          }
        )
      );
      const page = await inbox.listItems(channel, window(), meter());
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA]);
      expect(page.items.map((item) => item.id)).toEqual([COMMENT]);
    });

    it('uses the page token before "___" and records usage', async () => {
      respond(
        () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: {
              'x-business-use-case-usage': JSON.stringify({
                '1': [{ total_time: 88, estimated_time_to_regain_access: 9 }],
              }),
            },
          })
      );
      const usage = meter();
      await inbox.listItems(channel, window(), usage);
      expect(call().url.searchParams.get('access_token')).toBe(pageToken);
      expect(call().raw).not.toContain(userToken);
      expect(usage.usage).toEqual({ percent: 88, regainMinutes: 9 });
    });

    it('leaves usage null without the header', async () => {
      respond(() => json({ data: [] }));
      const usage = meter();
      await inbox.listItems(channel, window(), usage);
      expect(usage.usage).toBeNull();
    });

    it('throws the error of Meta and unavailable, and never writes', async () => {
      respond(() => json({ error: { message: 'x', code: 190 } }, 401));
      await expect(
        inbox.listItems(channel, window(), meter())
      ).rejects.toMatchObject({ details: { status: 401, code: 190 } });
      fetchMock.mockRejectedValue(new Error('fetch failed'));
      await expect(
        inbox.listItems(channel, window(), meter())
      ).rejects.toMatchObject({ details: { unavailable: true } });
      for (let i = 0; i < fetchMock.mock.calls.length; i++) {
        expect(call(i).init.method).toBe('GET');
      }
    });

    it('throws for an account id that is not valid, without fetch', async () => {
      await expect(
        inbox.listItems({ ...channel, internalId: '../me' }, window(), meter())
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getConversation (PR 73)', () => {
    const THREAD = `id,text,timestamp,username,like_count,hidden,user,replies{id,text,timestamp,username,like_count,hidden,user}`;
    const mediaOf = (owner: unknown) => ({
      id: MEDIA,
      permalink: 'https://www.instagram.com/p/ERFUNDEN/',
      timestamp: '2026-11-01T10:00:00+0000',
      media_type: 'IMAGE',
      comments_count: 2,
      owner,
    });
    const thread = (id: string, replies: unknown[]) => ({
      id,
      text: 'Oben',
      username: 'erfundene_person',
      replies: { data: replies },
    });

    it('gives the thread of a top-level comment of an own media', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return url.searchParams.get('fields') === 'id,media,parent_id'
            ? json({ id: COMMENT, media: { id: MEDIA } })
            : json(thread(COMMENT, [{ id: REPLY, text: 'Unten' }]));
        }
        return json(mediaOf({ id: IG }));
      });
      const usage = new InboxUsageMeter();
      const found = await inbox.getConversation(channel, COMMENT, usage);

      expect(found?.post).toEqual({
        id: MEDIA,
        permalink: 'https://www.instagram.com/p/ERFUNDEN/',
        timestamp: '2026-11-01T10:00:00+0000',
        mediaType: 'IMAGE',
        commentsCount: 2,
        truncated: false,
      });
      expect(found?.items.map((item) => [item.id, item.parentId])).toEqual([
        [COMMENT, null],
        [REPLY, COMMENT],
      ]);
      expect(found?.items.every((item) => item.postId === MEDIA)).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(1).url.pathname).toBe(`/${META_GRAPH_API_VERSION}/${MEDIA}`);
      expect(call(1).url.searchParams.get('fields')).toBe(
        'owner,id,permalink,timestamp,media_type,comments_count'
      );
      expect(call(2).url.pathname).toBe(
        `/${META_GRAPH_API_VERSION}/${COMMENT}`
      );
      expect(call(2).url.searchParams.get('fields')).toBe(THREAD);
      for (let i = 0; i < 3; i++) {
        expect(call(i).init.method).toBe('GET');
      }
    });

    it('gives the thread of the top-level comment when the id is a reply', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${REPLY}`)) {
          return json({ id: REPLY, parent_id: COMMENT });
        }
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return url.searchParams.get('fields') === 'id,media'
            ? json({ id: COMMENT, media: { id: MEDIA } })
            : json(thread(COMMENT, [{ id: REPLY }]));
        }
        return json(mediaOf({ id: IG }));
      });
      const found = await inbox.getConversation(
        channel,
        REPLY,
        new InboxUsageMeter()
      );
      expect(found?.items.map((item) => item.id)).toEqual([COMMENT, REPLY]);
    });

    it('marks the post truncated when the replies have more pages', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return url.searchParams.get('fields') === 'id,media,parent_id'
            ? json({ id: COMMENT, media: { id: MEDIA } })
            : json({
                ...thread(COMMENT, [{ id: REPLY }]),
                replies: {
                  data: [{ id: REPLY }],
                  paging: { next: 'https://x' },
                },
              });
        }
        return json(mediaOf({ id: IG }));
      });
      const found = await inbox.getConversation(
        channel,
        COMMENT,
        new InboxUsageMeter()
      );
      expect(found?.post?.truncated).toBe(true);
    });

    it('is null for media of another account, and reads no thread', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}`)
          ? json({ id: COMMENT, media: { id: MEDIA } })
          : json(mediaOf({ id: '17840000000000999' }))
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('is null for a reply under a foreign post', async () => {
      respond((url) => {
        if (url.pathname.endsWith(`/${REPLY}`)) {
          return json({ id: REPLY, parent_id: COMMENT });
        }
        if (url.pathname.endsWith(`/${COMMENT}`)) {
          return json({ id: COMMENT, media: { id: MEDIA } });
        }
        return json(mediaOf({ id: '17840000000000999' }));
      });
      expect(
        await inbox.getConversation(channel, REPLY, new InboxUsageMeter())
      ).toBeNull();
    });

    it('is null when owner is missing', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${COMMENT}`)
          ? json({ id: COMMENT, media: { id: MEDIA } })
          : json({ id: MEDIA })
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
    });

    it('is null for an unknown comment (code 100, subcode 33)', async () => {
      respond(() =>
        json(
          {
            error: {
              message: 'Object does not exist',
              code: 100,
              error_subcode: 33,
            },
          },
          400
        )
      );
      expect(
        await inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).toBeNull();
    });

    it('throws any other error of Meta', async () => {
      respond(() => json({ error: { message: 'x', code: 190 } }, 401));
      await expect(
        inbox.getConversation(channel, COMMENT, new InboxUsageMeter())
      ).rejects.toMatchObject({ details: { status: 401, code: 190 } });
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

    it('records usage of every call', async () => {
      respond((url) => {
        const header = {
          'x-business-use-case-usage': JSON.stringify({
            '1': [{ call_count: 35 }],
          }),
        };
        const body = url.pathname.endsWith(`/${COMMENT}`)
          ? url.searchParams.get('fields') === 'id,media,parent_id'
            ? { id: COMMENT, media: { id: MEDIA } }
            : thread(COMMENT, [])
          : mediaOf({ id: IG });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: header,
        });
      });
      const usage = new InboxUsageMeter();
      await inbox.getConversation(channel, COMMENT, usage);
      expect(usage.usage).toEqual({ percent: 35, regainMinutes: 0 });
    });
  });

  describe('fromOwner, window and budget per page (PR 73)', () => {
    const day = (offset: number) =>
      new Date(NOW - offset * 86_400_000).toISOString();
    const window = (patch: Partial<InboxWindow> = {}): InboxWindow => ({
      since: null,
      postsFrom: new Date(NOW - 30 * 86_400_000),
      postsBefore: null,
      cursor: null,
      ...patch,
    });
    const media = (id: string, created: string) => ({
      id,
      timestamp: created,
      comments_count: 0,
    });
    const MEDIA_3 = '17900000000000003';

    it('marks what the account wrote itself, by user.id, also from another tool', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${IG}/media`)
          ? json({
              data: [{ ...media(MEDIA, day(1)), comments_count: 4 }],
            })
          : json({
              data: [
                {
                  id: COMMENT,
                  username: 'erfundene_person',
                  user: { id: '17841000000000777' },
                  replies: {
                    data: [
                      { id: REPLY, username: 'konto', user: { id: IG } },
                      { id: `${REPLY}1`, username: 'x' },
                      { id: `${REPLY}2`, user: { id: `${IG}0` } },
                    ],
                  },
                },
                { id: COMMENT_2, user: { id: IG } },
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
      // Only the flag leaves, never the id of a person.
      expect(JSON.stringify(page)).not.toContain('17841000000000777');
    });

    it('marks fromOwner in the demo list (listComments)', async () => {
      respond((url) =>
        url.pathname.endsWith(`/${IG}/media`)
          ? json({ data: [{ id: MEDIA, comments_count: 1 }] })
          : json({ data: [{ id: COMMENT, user: { id: IG } }] })
      );
      const posts = await inbox.listComments(channel);
      expect(posts[0].comments[0].fromOwner).toBe(true);
    });

    it('with postsFrom from postsAfter ends at the first media older than it', async () => {
      respond(() =>
        json({
          data: [
            media(MEDIA, day(2)),
            media(MEDIA_2, day(20)),
            media(MEDIA_3, day(50)),
          ],
          paging: { next: 'https://x', cursors: { after: 'MORE' } },
        })
      );
      const page = await inbox.listItems(
        channel,
        window({
          postsBefore: new Date(day(10)),
          postsFrom: new Date(day(30)),
        }),
        new InboxUsageMeter()
      );
      // The newer media is skipped, the older one than postsAfter ends it.
      expect(page.posts.map((p) => p.id)).toEqual([MEDIA_2]);
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('starts the next page only when the time of the last page still fits', async () => {
      let n = 0;
      respond(() => {
        inbox.now += 10_000;
        n++;
        return json({
          data: [media(`${MEDIA}${n}`, day(1))],
          paging: { next: 'https://x', cursors: { after: `P${n + 1}` } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      // 10 s, 20 s, then 20 + 10 > 25 s.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(page.nextCursor).toBe('P3');
      expect(page.posts).toHaveLength(2);
    });

    it('always reads the first page, however slow', async () => {
      respond(() => {
        inbox.now += 90_000;
        return json({
          data: [media(MEDIA, day(1))],
          paging: { next: 'https://x', cursors: { after: 'P2' } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(page.nextCursor).toBe('P2');
    });

    it('counts the comment reads of a page into its time', async () => {
      respond((url) => {
        if (url.pathname.endsWith('/comments')) {
          inbox.now += 20_000;
          return json({ data: [] });
        }
        return json({
          data: [{ ...media(MEDIA, day(1)), comments_count: 1 }],
          paging: { next: 'https://x', cursors: { after: 'P2' } },
        });
      });
      const page = await inbox.listItems(
        channel,
        window(),
        new InboxUsageMeter()
      );
      // The first page took 20 s: 20 + 20 > 25 s.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(page.nextCursor).toBe('P2');
    });

    it('ends on a cursor that comes again and on a page without media', async () => {
      respond(() =>
        json({
          data: [media(MEDIA, day(1))],
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

  describe('postId and the missing reply (PR 73)', () => {
    const FIELDS = 'id,text,timestamp,username,like_count,hidden,user';
    const platform =
      (options: { thread?: unknown } = {}) =>
      (url: URL) => {
        const path = url.pathname.replace(`/${META_GRAPH_API_VERSION}`, '');
        if (path === `/${REPLY}`) {
          return url.searchParams.get('fields') === 'id,media,parent_id'
            ? json({ id: REPLY, parent_id: COMMENT })
            : json({ id: REPLY, text: 'Unten', user: { id: IG } });
        }
        if (path === `/${COMMENT}`) {
          return url.searchParams.get('fields')?.includes('replies')
            ? json(options.thread ?? { id: COMMENT, replies: { data: [] } })
            : json({ id: COMMENT, media: { id: MEDIA } });
        }
        if (path === `/${MEDIA}`) {
          return json({
            id: MEDIA,
            owner: { id: IG },
            timestamp: '2026-11-01T10:00:00+0000',
            media_type: 'IMAGE',
            comments_count: 2,
          });
        }
        return json({ error: { message: 'unexpected', code: 1 } }, 400);
      };

    it('adds a reply that is not in the first page of replies, read on its own', async () => {
      respond(platform());
      const found = await inbox.getConversation(
        channel,
        REPLY,
        new InboxUsageMeter()
      );
      const own = fetchMock.mock.calls
        .map((_, i) => call(i))
        .filter(
          (c) =>
            c.url.pathname === `/${META_GRAPH_API_VERSION}/${REPLY}` &&
            c.url.searchParams.get('fields') === FIELDS
        );
      expect(own).toHaveLength(1);
      expect(
        found?.items.map((item) => [item.id, item.parentId, item.fromOwner])
      ).toEqual([
        [COMMENT, null, false],
        [REPLY, COMMENT, true],
      ]);
      expect(found?.items.every((item) => item.postId === MEDIA)).toBe(true);
    });

    it('does not read the reply again when the thread has it', async () => {
      respond(
        platform({
          thread: { id: COMMENT, replies: { data: [{ id: REPLY }] } },
        })
      );
      await inbox.getConversation(channel, REPLY, new InboxUsageMeter());
      expect(
        fetchMock.mock.calls
          .map((_, i) => call(i))
          .filter((c) => c.url.searchParams.get('fields') === FIELDS)
      ).toHaveLength(0);
    });

    it('ignores postId: the same calls with and without it, and it is in no URL', async () => {
      respond(platform());
      await inbox.getConversation(channel, COMMENT, new InboxUsageMeter());
      const without = fetchMock.mock.calls.map(([raw]: any) => String(raw));

      fetchMock.mockReset();
      respond(platform());
      await (inbox as YsocialInboxProvider).getConversation(
        channel,
        COMMENT,
        new InboxUsageMeter(),
        '17900000000000099'
      );
      expect(fetchMock.mock.calls.map(([raw]: any) => String(raw))).toEqual(
        without
      );
      expect(without.join(' ')).not.toContain('17900000000000099');
    });

    it('ownsComment asks only for the owner of the media and ignores postId', async () => {
      respond(platform());
      expect(
        await (inbox as YsocialInboxProvider).ownsComment(
          channel,
          COMMENT,
          MEDIA_2
        )
      ).toBe(true);
      expect(call(1).url.searchParams.get('fields')).toBe('owner');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('has no budget in the check: it never throws the ownership error', async () => {
      respond((url) => {
        inbox.now += 90_000;
        return platform()(url);
      });
      await expect(inbox.ownsComment(channel, COMMENT)).resolves.toBe(true);
    });
  });

  describe('like (PR 73)', () => {
    it('is not supported: capabilities.like is false and like throws without fetch', async () => {
      expect(inbox.capabilities.like).toBe(false);
      await expect(inbox.like()).rejects.toThrow('not supported');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allows reply, hide and delete, no realtime yet', () => {
      expect(inbox.capabilities).toEqual({
        reply: true,
        hide: true,
        delete: true,
        like: false,
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
