import { randomBytes } from 'crypto';
import {
  InboxOwnershipUnknownError,
  InboxPlatformError,
  InboxUsageMeter,
  InboxWindow,
} from './inbox.rules';
import {
  LINKEDIN_CALLS_PER_READ,
  LINKEDIN_INBOX_API_VERSION,
  LINKEDIN_START_BUDGET_MS,
  LinkedinInbox,
  linkedinApi,
} from './linkedin.inbox';

// Invented ids. The organization is a number, the posts and comments are
// numbers as well (URN_KINDS: 0 activity, 1 share, 2 ugcPost).
const ORG = '100000001';
const ORG_URN = `urn:li:organization:${ORG}`;
const FOREIGN_ORG_URN = 'urn:li:organization:100000999';
const PERSON_URN = 'urn:li:person:erfundenAbc';
const API = 'https://api.linkedin.com/rest';

const SHARE = '7000000000000000001';
const UGC = '7000000000000000002';
const ACTIVITY = '8000000000000000001';
const SHARE_POST = `1_${SHARE}`;
const UGC_POST = `2_${UGC}`;
const SHARE_URN = `urn:li:share:${SHARE}`;
const UGC_URN = `urn:li:ugcPost:${UGC}`;
const C1 = '9000000000000000001';
const C2 = '9000000000000000002';
const C3 = '9000000000000000003';
const R1 = '9100000000000000001';
const R2 = '9100000000000000002';

// share, ugcPost and activity threads
const SHARE_COMMENT = `1_${SHARE}_${C1}`;
const UGC_COMMENT = `2_${UGC}_${C2}`;
const ACTIVITY_COMMENT = `0_${ACTIVITY}_${C3}`;
const SHARE_REPLY = `1_${SHARE}_${C1}_${R1}`;
// The top-level comment of the share thread: a reply is written through it.
const PARENT = `urn:li:comment:(urn:li:share:${SHARE},${C1})`;

const accessToken = randomBytes(24).toString('hex');
const channel = { internalId: ORG, token: accessToken };

const NOW = Date.parse('2026-11-17T12:00:00Z');
const HOUR = 3_600_000;
const COMMENT_TEXT = 'Erfundener Kommentar';
const WINDOW: InboxWindow = {
  since: null,
  postsFrom: null,
  postsBefore: null,
  cursor: null,
};

class TestLinkedinInbox extends LinkedinInbox {
  now = NOW;
  // Every read of the clock moves it on by step ms.
  step = 0;
  protected clock = () => (this.now += this.step);
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const notFound = () => json({ status: 404, message: 'Not found' }, 404);

const commentUrn = (kind: string, thread: string, id: string) =>
  `urn:li:comment:(urn:li:${kind}:${thread},${id})`;

const commentRow = (
  kind: string,
  thread: string,
  id: string,
  over: Record<string, unknown> = {}
) => ({
  commentUrn: commentUrn(kind, thread, id),
  actor: PERSON_URN,
  message: { text: COMMENT_TEXT },
  created: { time: NOW - HOUR },
  likesSummary: { totalLikes: 3 },
  ...over,
});
const replyRow = (
  kind: string,
  thread: string,
  parent: string,
  id: string,
  over: Record<string, unknown> = {}
) =>
  commentRow(kind, thread, id, {
    parentComment: commentUrn(kind, thread, parent),
    ...over,
  });

const postRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: `urn:li:share:${7000000000000000100 + n}`,
  author: ORG_URN,
  lifecycleState: 'PUBLISHED',
  createdAt: NOW - n * HOUR,
  ...over,
});

interface Call {
  method: string;
  raw: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
}
type Reply = Response | object | null;
type Route = Reply | ((call: Call) => Reply);

describe('LinkedinInbox', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;
  let inbox: TestLinkedinInbox;

  // Routes by "METHOD decoded/path" below /rest/. Anything else: 404.
  const serve = (routes: Record<string, Route>) => {
    fetchMock.mockImplementation(async (raw: string, init: any) => {
      const url = new URL(raw);
      const path = decodeURIComponent(url.pathname).replace(/^\/rest\//, '');
      const call: Call = {
        method: init.method,
        raw,
        path,
        query: url.searchParams,
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : undefined,
      };
      const route = routes[`${init.method} ${path}`];
      const reply = typeof route === 'function' ? route(call) : route;
      if (reply === undefined) {
        return notFound();
      }
      return reply instanceof Response ? reply : json(reply);
    });
  };
  const call = (index = 0): Call => {
    const [raw, init] = fetchMock.mock.calls[index];
    const url = new URL(raw);
    return {
      method: init.method,
      raw,
      path: decodeURIComponent(url.pathname).replace(/^\/rest\//, ''),
      query: url.searchParams,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
  };

  // One post of the page with one comment and one reply of the share
  // thread, as the platform sends them.
  const oneThread = (over: Record<string, Route> = {}) =>
    serve({
      'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
      [`GET socialActions/${SHARE_URN}/comments`]: {
        elements: [
          commentRow('share', SHARE, C1, {
            commentsSummary: { totalFirstLevelComments: 1 },
          }),
        ],
      },
      [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
        elements: [replyRow('share', SHARE, C1, R1)],
      },
      ...over,
    });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    inbox = new TestLinkedinInbox();
  });

  afterEach(() => {
    global.fetch = original;
  });

  it('is the provider "linkedin-page"', () => {
    expect(inbox.identifier).toBe('linkedin-page');
  });

  describe('enabled', () => {
    it('is true only for YSOCIAL_INBOX_LINKEDIN=true', () => {
      expect(inbox.enabled({ YSOCIAL_INBOX_LINKEDIN: 'true' })).toBe(true);
    });

    it.each([['false'], ['TRUE'], ['1'], [''], [' true'], ['yes']])(
      'is false for %j',
      (value) => {
        expect(inbox.enabled({ YSOCIAL_INBOX_LINKEDIN: value })).toBe(false);
      }
    );

    it('is false without the variable, and when only the other switches are set', () => {
      expect(inbox.enabled({})).toBe(false);
      expect(
        inbox.enabled({
          YSOCIAL_INBOX_ENABLED: 'true',
          YSOCIAL_DEMO_INTEGRATIONS: 'int-1',
        })
      ).toBe(false);
    });
  });

  describe('capabilities', () => {
    it('can reply, delete and like, but not hide, and has no realtime', () => {
      expect(inbox.capabilities).toEqual({
        reply: true,
        hide: false,
        delete: true,
        like: true,
        realtime: false,
      });
    });

    it('never calls the platform for a hide', async () => {
      await expect(inbox.hide()).rejects.toBeInstanceOf(InboxPlatformError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('listItems: the call to the posts', () => {
    it('asks the finder for the posts of the organization, newest creation first, 5 at a time', async () => {
      serve({ 'GET posts': { elements: [] } });
      expect(await inbox.listItems(channel, WINDOW)).toEqual({
        posts: [],
        items: [],
        nextCursor: null,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const first = call();
      expect(first.method).toBe('GET');
      expect(first.raw.startsWith(`${API}/posts?`)).toBe(true);
      expect(Object.fromEntries(first.query)).toEqual({
        q: 'author',
        author: ORG_URN,
        sortBy: 'CREATED',
        count: '5',
        start: '0',
      });
      expect(first.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
        'X-RestLi-Method': 'FINDER',
      });
      expect(LINKEDIN_INBOX_API_VERSION).toBe('202611');
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    });

    it('starts at the number in the cursor', async () => {
      serve({ 'GET posts': { elements: [] } });
      await inbox.listItems(channel, { ...WINDOW, cursor: '15' });
      expect(call().query.get('start')).toBe('15');
    });

    it.each([['abc'], ['-1'], ['1.5'], ['1234567'], ['']])(
      'starts at 0 for the cursor %j',
      async (cursor) => {
        serve({ 'GET posts': { elements: [] } });
        await inbox.listItems(channel, { ...WINDOW, cursor });
        expect(call().query.get('start')).toBe('0');
      }
    );

    it('sends the finder header on the post finder only', async () => {
      oneThread();
      await inbox.listItems(channel, WINDOW);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(0).headers['X-RestLi-Method']).toBe('FINDER');
      for (const index of [1, 2]) {
        expect(call(index).headers).not.toHaveProperty('X-RestLi-Method');
        expect(call(index).headers).toMatchObject({
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': '202611',
          'X-Restli-Protocol-Version': '2.0.0',
        });
      }
    });

    it('reads the comments of a post, then the replies of a comment, with encoded URNs', async () => {
      oneThread();
      await inbox.listItems(channel, WINDOW);

      const comments = call(1);
      expect(comments.method).toBe('GET');
      expect(comments.raw).toBe(
        `${API}/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments?count=50`
      );
      const replies = call(2);
      expect(replies.method).toBe('GET');
      expect(replies.raw).toBe(
        `${API}/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29/comments?count=25`
      );
    });

    it('reads a ugcPost the same way, with its own URN', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: UGC_URN })] },
        [`GET socialActions/${UGC_URN}/comments`]: { elements: [] },
      });
      const page = await inbox.listItems(channel, WINDOW);
      expect(call(1).raw).toBe(
        `${API}/socialActions/urn%3Ali%3AugcPost%3A${UGC}/comments?count=50`
      );
      expect(page.posts.map((post) => post.id)).toEqual([UGC_POST]);
    });
  });

  describe('listItems: the entries', () => {
    it('answers the post, the comment and the reply without any URN', async () => {
      oneThread();
      const page = await inbox.listItems(channel, WINDOW);

      expect(page.nextCursor).toBeNull();
      expect(page.posts).toEqual([
        {
          id: `1_${SHARE}`,
          permalink: `https://www.linkedin.com/feed/update/${SHARE_URN}/`,
          timestamp: new Date(NOW - HOUR).toISOString(),
          mediaType: null,
          commentsCount: null,
          truncated: false,
        },
      ]);
      expect(page.items).toEqual([
        {
          id: SHARE_COMMENT,
          postId: SHARE_POST,
          parentId: null,
          text: COMMENT_TEXT,
          username: null,
          timestamp: new Date(NOW - HOUR).toISOString(),
          likeCount: 3,
          hidden: false,
          fromOwner: false,
          mentions: [],
        },
        {
          id: SHARE_REPLY,
          postId: SHARE_POST,
          parentId: SHARE_COMMENT,
          text: COMMENT_TEXT,
          username: null,
          timestamp: new Date(NOW - HOUR).toISOString(),
          likeCount: 3,
          hidden: false,
          fromOwner: false,
          mentions: [],
        },
      ]);
      // the permalink of a post is a URL, the entries carry no URN
      expect(JSON.stringify(page.items)).not.toContain('urn:li');
      expect(JSON.stringify(page)).not.toContain(accessToken);
    });

    it('sets fromOwner when the actor is the organization', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              actor: ORG_URN,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C2, {
              actor: FOREIGN_ORG_URN,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C3, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => [item.id, item.fromOwner])).toEqual([
        [`1_${SHARE}_${C1}`, true],
        [`1_${SHARE}_${C2}`, false],
        [`1_${SHARE}_${C3}`, false],
      ]);
    });

    it('takes likeCount from likesSummary.totalLikes, 0 when missing or odd', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              likesSummary: { totalLikes: 12 },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C2, {
              likesSummary: undefined,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C3, {
              likesSummary: { totalLikes: 'viele' },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.likeCount)).toEqual([12, 0, 0]);
    });

    it('turns created.time in ms into an ISO time, null when missing or odd', async () => {
      const time = Date.parse('2026-11-10T10:20:30.456Z');
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              created: { time },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C2, {
              created: undefined,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('share', SHARE, C3, {
              created: { time: 'gestern' },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.timestamp)).toEqual([
        '2026-11-10T10:20:30.456Z',
        null,
        null,
      ]);
    });

    it('gives an empty text for a comment without message', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              message: undefined,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items[0].text).toBe('');
      expect(items[0].mentions).toEqual([]);
    });

    it('reads comments of the share, ugcPost and activity thread of one post', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('ugcPost', UGC, C2, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('activity', ACTIVITY, C3, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.id)).toEqual([
        SHARE_COMMENT,
        UGC_COMMENT,
        ACTIVITY_COMMENT,
      ]);
      expect(items.every((item) => item.postId === SHARE_POST)).toBe(true);
    });

    it('turns a reply of the activity thread into <0>_<thread>_<parent>_<id>', async () => {
      const topUrn = commentUrn('activity', ACTIVITY, C3);
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [commentRow('activity', ACTIVITY, C3)],
        },
        [`GET socialActions/${topUrn}/comments`]: {
          elements: [replyRow('activity', ACTIVITY, C3, R1)],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => [item.id, item.parentId])).toEqual([
        [ACTIVITY_COMMENT, null],
        [`0_${ACTIVITY}_${C3}_${R1}`, ACTIVITY_COMMENT],
      ]);
    });

    it('drops a reply that belongs to another thread', async () => {
      const topUrn = commentUrn('share', SHARE, C1);
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [commentRow('share', SHARE, C1)],
        },
        [`GET socialActions/${topUrn}/comments`]: {
          elements: [
            replyRow('share', SHARE, C1, R1),
            // another thread of the same kind
            { ...replyRow('share', '7999999', C1, R2) },
            // another kind of thread
            { ...replyRow('ugcPost', SHARE, C1, R2) },
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.id)).toEqual([
        SHARE_COMMENT,
        SHARE_REPLY,
      ]);
    });

    it('drops rows with an invalid or missing commentUrn, and nested rows on the top level', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            { ...commentRow('share', SHARE, C2), commentUrn: undefined },
            {
              ...commentRow('share', SHARE, C2),
              commentUrn: 'urn:li:comment:x',
            },
            {
              ...commentRow('share', SHARE, C2),
              commentUrn: `urn:li:comment:(urn:li:share:${SHARE}/../x,${C2})`,
            },
            {
              ...commentRow('share', SHARE, C2),
              commentUrn: `urn:li:comment:(urn:li:video:${SHARE},${C2})`,
            },
            {
              ...commentRow('share', SHARE, C2),
              commentUrn: `urn:li:comment:(urn:li:share:${SHARE},abc)`,
            },
            null,
            'text',
            replyRow('share', SHARE, C1, C2),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.id)).toEqual([SHARE_COMMENT]);
    });

    it('keeps the longest reply id at 64 characters', async () => {
      const big = '9'.repeat(19);
      const top = commentUrn('share', big, big);
      serve({
        'GET posts': { elements: [postRow(1, { id: `urn:li:share:${big}` })] },
        [`GET socialActions/urn:li:share:${big}/comments`]: {
          elements: [commentRow('share', big, big)],
        },
        [`GET socialActions/${top}/comments`]: {
          elements: [replyRow('share', big, big, big)],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.id.length).toBeLessThanOrEqual(64);
        expect(item.id).toMatch(/^[0-9_]+$/);
      }
      expect(items[1].id).toBe(`1_${big}_${big}_${big}`);
    });
  });

  describe('listItems: mentions', () => {
    const withAttributes = (message: string, attributes: unknown) =>
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              message: { text: message, attributes },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });

    it('takes the part of the text of a person and of an organization, never the URN', async () => {
      withAttributes('Danke Erika und Werkstatt Beispiel!', [
        { start: 6, length: 5, value: { person: 'urn:li:person:abc' } },
        {
          start: 16,
          length: 18,
          value: { organization: 'urn:li:organization:555' },
        },
      ]);
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.items[0].mentions).toEqual(['Erika', 'Werkstatt Beispiel']);
      expect(JSON.stringify(page.items)).not.toContain('urn:li');
    });

    it('leaves out other kinds of attributes, such as a hashtag', async () => {
      withAttributes('Das ist #Erfunden', [
        { start: 8, length: 9, value: { hashtag: 'erfunden' } },
        { start: 0, length: 3, value: {} },
        { start: 0, length: 3 },
        null,
      ]);
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items[0].mentions).toEqual([]);
    });

    it.each([
      ['a start outside the text', { start: 50, length: 3 }],
      ['a length that ends outside the text', { start: 3, length: 50 }],
      ['a negative start', { start: -1, length: 3 }],
      ['a length of 0', { start: 2, length: 0 }],
      ['no numbers', { start: '2', length: '3' }],
      ['fractions', { start: 1.5, length: 2 }],
    ])('drops an attribute with %s', async (_name, position) => {
      withAttributes('Danke Erika', [
        { ...position, value: { person: 'urn:li:person:abc' } },
      ]);
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items[0].mentions).toEqual([]);
    });

    it('drops a part that would cut a surrogate pair, counts in UTF-16 units', async () => {
      withAttributes('A😀B Erika', [
        { start: 1, length: 1, value: { person: 'urn:li:person:a' } },
        { start: 4, length: 6, value: { person: 'urn:li:person:b' } },
      ]);
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items[0].mentions).toEqual(['Erika']);
    });

    it('answers no mentions when attributes is not a list', async () => {
      withAttributes('Danke Erika', { start: 6, length: 5 });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items[0].mentions).toEqual([]);
    });
  });

  describe('listItems: which posts count', () => {
    it('reads only PUBLISHED posts of the organization with a share or ugcPost URN', async () => {
      serve({
        'GET posts': (c) => ({
          elements:
            c.query.get('start') !== '0'
              ? []
              : [
                  postRow(1, { id: SHARE_URN }),
                  postRow(2, { lifecycleState: 'DRAFT' }),
                  postRow(3, { lifecycleState: 'PUBLISH_REQUESTED' }),
                  postRow(4, { author: FOREIGN_ORG_URN }),
                  postRow(5, { author: PERSON_URN }),
                  postRow(6, { id: 'urn:li:activity:123' }),
                  postRow(7, { id: undefined }),
                  null,
                ],
        }),
        [`GET socialActions/${SHARE_URN}/comments`]: { elements: [] },
      });
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.posts.map((post) => post.id)).toEqual([SHARE_POST]);
      // the full page of 8 rows asks for the next one (start 8), then the
      // finder, the comments of the one post and the empty page
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(2).query.get('start')).toBe('8');
    });

    it('does not read the comments of a post outside the window', async () => {
      serve({
        'GET posts': {
          elements: [
            postRow(1, { id: SHARE_URN }),
            postRow(2, { id: UGC_URN, createdAt: NOW - 100 * 24 * HOUR }),
          ],
        },
        [`GET socialActions/${SHARE_URN}/comments`]: { elements: [] },
      });
      await inbox.listItems(channel, {
        ...WINDOW,
        postsFrom: new Date(NOW - 30 * 24 * HOUR),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('listItems: the window', () => {
    it('ends at the first post older than postsFrom, with no cursor', async () => {
      const posts = [1, 2, 3, 4, 5].map((n) =>
        postRow(n, {
          id: `urn:li:share:70000000000000010${n}`,
          createdAt: NOW - n * 24 * HOUR,
        })
      );
      serve({
        'GET posts': { elements: posts },
        [`GET socialActions/${posts[0].id}/comments`]: { elements: [] },
        [`GET socialActions/${posts[1].id}/comments`]: { elements: [] },
      });
      const page = await inbox.listItems(channel, {
        ...WINDOW,
        postsFrom: new Date(NOW - 2.5 * 24 * HOUR),
      });
      expect(page.nextCursor).toBeNull();
      expect(page.posts).toHaveLength(2);
      // finder and two posts: no second page, no read of the older posts
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ends in the middle of a later page as well', async () => {
      const row = (n: number) =>
        postRow(n, {
          id: `urn:li:share:70000000000000010${n}`,
          createdAt: NOW - n * 24 * HOUR,
        });
      serve({
        'GET posts': (c) =>
          c.query.get('start') === '0'
            ? { elements: [1, 2, 3, 4, 5].map(row) }
            : { elements: [6, 7].map(row) },
        [`GET socialActions/${row(1).id}/comments`]: { elements: [] },
        [`GET socialActions/${row(2).id}/comments`]: { elements: [] },
        [`GET socialActions/${row(3).id}/comments`]: { elements: [] },
        [`GET socialActions/${row(4).id}/comments`]: { elements: [] },
        [`GET socialActions/${row(5).id}/comments`]: { elements: [] },
        [`GET socialActions/${row(6).id}/comments`]: { elements: [] },
      });
      const page = await inbox.listItems(channel, {
        ...WINDOW,
        postsFrom: new Date(NOW - 6.5 * 24 * HOUR),
      });
      expect(page.posts).toHaveLength(6);
      expect(page.nextCursor).toBeNull();
      const finders = fetchMock.mock.calls
        .map((_, i) => call(i))
        .filter((c) => c.path === 'posts');
      expect(finders.map((c) => c.query.get('start'))).toEqual(['0', '5']);
    });

    it('skips posts at or after postsBefore, without reading them', async () => {
      serve({
        'GET posts': {
          elements: [
            postRow(0, { id: UGC_URN, createdAt: NOW - HOUR }),
            postRow(1, { id: SHARE_URN, createdAt: NOW - 5 * 24 * HOUR }),
          ],
        },
        [`GET socialActions/${SHARE_URN}/comments`]: { elements: [] },
      });
      const page = await inbox.listItems(channel, {
        ...WINDOW,
        postsBefore: new Date(NOW - 24 * HOUR),
      });
      expect(page.posts.map((post) => post.id)).toEqual([SHARE_POST]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('filters comments and replies with since, at or after it', async () => {
      const since = new Date(NOW - 2 * HOUR);
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            // old comment with a new reply
            commentRow('share', SHARE, C1, {
              created: { time: NOW - 5 * HOUR },
            }),
            // exactly at since
            commentRow('share', SHARE, C2, {
              created: { time: since.getTime() },
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            // without a time: counts
            commentRow('share', SHARE, C3, {
              created: undefined,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [
            replyRow('share', SHARE, C1, R1, {
              created: { time: NOW - 3 * HOUR },
            }),
            replyRow('share', SHARE, C1, R2, { created: { time: NOW - HOUR } }),
          ],
        },
      });
      const page = await inbox.listItems(channel, { ...WINDOW, since });
      expect(page.items.map((item) => item.id)).toEqual([
        `1_${SHARE}_${C1}_${R2}`,
        `1_${SHARE}_${C2}`,
        `1_${SHARE}_${C3}`,
      ]);
      // the post stays in the page even if nothing is new under it
      expect(page.posts).toHaveLength(1);
    });
  });

  describe('listItems: the limit of calls and the time', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        postRow(i + 1, { id: `urn:li:share:70000000000000020${i + 10}` })
      );
    // Every post has one comment with one reply: two calls per post.
    const threads = (posts: ReturnType<typeof many>) => {
      const routes: Record<string, Route> = {
        'GET posts': (c) => {
          const start = +c.query.get('start')!;
          return { elements: posts.slice(start, start + 5) };
        },
      };
      posts.forEach((post, i) => {
        const id = `91000000000000030${i + 10}`;
        const thread = String(post.id).split(':')[3];
        routes[`GET socialActions/${post.id}/comments`] = {
          elements: [
            commentRow('share', thread, id, {
              commentsSummary: { totalFirstLevelComments: 1 },
            }),
          ],
        };
        routes[
          `GET socialActions/${commentUrn('share', thread, id)}/comments`
        ] = { elements: [replyRow('share', thread, id, R1)] };
      });
      return routes;
    };

    it('makes at most 20 calls and continues with the number of the next post', async () => {
      expect(LINKEDIN_CALLS_PER_READ).toBe(20);
      serve(threads(many(12)));
      const page = await inbox.listItems(channel, WINDOW);

      // 1 + 5 * 2 (page 1) + 1 (page 2) + 4 * 2 = 20
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(page.posts).toHaveLength(9);
      expect(page.nextCursor).toBe('9');
      // every post read is read whole: comment and reply of each
      expect(page.items).toHaveLength(18);
      expect(page.posts.every((post) => !post.truncated)).toBe(true);
    });

    it('continues where the cursor says, with the post it stopped before', async () => {
      serve(threads(many(12)));
      const second = await inbox.listItems(channel, {
        ...WINDOW,
        cursor: '9',
      });
      expect(call(0).query.get('start')).toBe('9');
      expect(second.posts).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
    });

    it('stops before the next post when a page was read and 20 calls are used', async () => {
      // 5 posts of 4 calls each would be 21 calls: the page ends before the
      // fifth post, not in it.
      const posts = many(10);
      const routes = threads(posts);
      // a second comment with a reply per post: 3 calls per comment set
      posts.forEach((post, i) => {
        const thread = String(post.id).split(':')[3];
        const idA = `91000000000000030${i + 10}`;
        const idB = `92000000000000030${i + 10}`;
        routes[`GET socialActions/${post.id}/comments`] = {
          elements: [
            commentRow('share', thread, idA, {
              commentsSummary: { totalFirstLevelComments: 1 },
            }),
            commentRow('share', thread, idB, {
              commentsSummary: { totalFirstLevelComments: 1 },
            }),
          ],
        };
        routes[
          `GET socialActions/${commentUrn('share', thread, idB)}/comments`
        ] = { elements: [replyRow('share', thread, idB, R2)] };
      });
      serve(routes);
      const page = await inbox.listItems(channel, WINDOW);

      // 1 + 3 * 4 = 13; the fifth post would start at 13 < 20 and end at 17;
      // the page goes on to the second page: 18, then the first post 22
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(24);
      expect(page.nextCursor).not.toBeNull();
      const done = page.posts.length;
      expect(page.nextCursor).toBe(String(done));
      // every post in the page was read whole (4 items each)
      expect(page.items).toHaveLength(done * 4);
    });

    it('marks a post truncated when its own comments run past 20 calls', async () => {
      const postUrn = SHARE_URN;
      const rows = Array.from({ length: 30 }, (_, i) =>
        commentRow('share', SHARE, `93000000000000000${i + 10}`, {
          commentsSummary: { totalFirstLevelComments: 1 },
        })
      );
      const routes: Record<string, Route> = {
        'GET posts': { elements: [postRow(1, { id: postUrn })] },
        [`GET socialActions/${postUrn}/comments`]: { elements: rows },
      };
      for (const row of rows) {
        const id = row.commentUrn.split(',')[1].slice(0, -1);
        routes[`GET socialActions/${row.commentUrn}/comments`] = {
          elements: [],
        };
        expect(id).toMatch(/^\d+$/);
      }
      serve(routes);
      const page = await inbox.listItems(channel, WINDOW);

      expect(fetchMock).toHaveBeenCalledTimes(LINKEDIN_CALLS_PER_READ);
      expect(page.posts[0].truncated).toBe(true);
      expect(page.items).toHaveLength(30);
    });

    it('reads the replies of a comment with commentsSummary, and of one without it', async () => {
      const read = (summary: unknown) => {
        const topUrn = commentUrn('share', SHARE, C1);
        serve({
          'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
          [`GET socialActions/${SHARE_URN}/comments`]: {
            elements: [
              commentRow('share', SHARE, C1, { commentsSummary: summary }),
            ],
          },
          [`GET socialActions/${topUrn}/comments`]: { elements: [] },
        });
        fetchMock.mockClear();
        return inbox
          .listItems(channel, WINDOW)
          .then(() => fetchMock.mock.calls.length);
      };
      // finder, comments, replies
      expect(await read(undefined)).toBe(3);
      expect(await read({})).toBe(3);
      expect(await read({ totalFirstLevelComments: 2 })).toBe(3);
      expect(await read({ aggregatedTotalComments: 2 })).toBe(3);
      // finder, comments
      expect(await read({ totalFirstLevelComments: 0 })).toBe(2);
      expect(await read({ aggregatedTotalComments: 0 })).toBe(2);
    });

    it('always reads the first post, then ends before the next when the time is up', async () => {
      inbox.step = LINKEDIN_START_BUDGET_MS + 1000;
      serve(threads(many(3)));
      const page = await inbox.listItems(channel, WINDOW);

      // the cursor moves on: one post read, the next one is the cursor
      expect(page.posts).toHaveLength(1);
      expect(page.nextCursor).toBe('1');
      // finder and the comments; no time left for the replies
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(page.posts[0].truncated).toBe(true);
      expect(page.items).toHaveLength(1);
    });

    it('moves on from a cursor even when the time is up at once', async () => {
      inbox.step = LINKEDIN_START_BUDGET_MS + 1000;
      serve(threads(many(12)));
      const page = await inbox.listItems(channel, { ...WINDOW, cursor: '3' });
      expect(page.posts).toHaveLength(1);
      expect(page.nextCursor).toBe('4');
    });

    it('reads no replies once the time is up, the demo included', async () => {
      inbox.step = LINKEDIN_START_BUDGET_MS + 1000;
      serve(threads(many(3)));
      const posts = await inbox.listComments(channel);
      // the first read of the demo checks the time before a post
      expect(posts).toEqual([]);
    });

    it('exports a start budget of 20 s', () => {
      expect(LINKEDIN_START_BUDGET_MS).toBe(20_000);
    });

    it('goes on within the budget', async () => {
      inbox.step = 1000;
      serve(threads(many(3)));
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.posts).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });

    it('ends after a full page when the budget is used up, with the cursor of the next page', async () => {
      // the first reads of the clock are cheap, then it jumps
      let reads = 0;
      (inbox as any).clock = () => (++reads > 7 ? NOW + 60_000 : NOW);
      serve(threads(many(12)));
      const page = await inbox.listItems(channel, WINDOW);

      expect(page.nextCursor).not.toBeNull();
      expect(/^\d+$/.test(page.nextCursor!)).toBe(true);
      expect(page.posts.length).toBe(+page.nextCursor!);
    });
  });

  describe('listItems: truncated', () => {
    it.each([
      ['paging.total above what came', { paging: { start: 0, total: 80 } }],
      [
        'a link with rel next',
        { paging: { links: [{ rel: 'prev' }, { rel: 'next' }] } },
      ],
    ])('is true for %s on the comments', async (_name, extra) => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
          ...extra,
        },
      });
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.posts[0].truncated).toBe(true);
    });

    it('is true when the replies have more', async () => {
      oneThread({
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [replyRow('share', SHARE, C1, R1)],
          paging: { start: 0, count: 25, total: 60 },
        },
      });
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.posts[0].truncated).toBe(true);
    });

    it.each([
      ['a total that came whole', { paging: { start: 0, total: 1 } }],
      ['a link prev only', { paging: { links: [{ rel: 'prev' }] } }],
      ['no paging', {}],
    ])('is false for %s', async (_name, extra) => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
          ...extra,
        },
      });
      const page = await inbox.listItems(channel, WINDOW);
      expect(page.posts[0].truncated).toBe(false);
    });
  });

  describe('listItems: errors', () => {
    it('rejects an invalid organization id before any call', async () => {
      serve({});
      await expect(
        inbox.listItems({ internalId: '12/../3', token: accessToken }, WINDOW)
      ).rejects.toThrow('invalid platform id');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes a 403 (role ADMINISTRATOR missing) on as a platform error', async () => {
      serve({
        'GET posts': json(
          {
            status: 403,
            serviceErrorCode: 100,
            message: 'Not enough permissions',
          },
          403
        ),
      });
      const err: InboxPlatformError = await inbox
        .listItems(channel, WINDOW)
        .catch((e) => e);
      expect(err).toBeInstanceOf(InboxPlatformError);
      expect(err.details).toMatchObject({
        unavailable: false,
        status: 403,
        code: 100,
        reason: 'Not enough permissions',
      });
    });

    it('says unreadable for an answer to a read without a JSON object', async () => {
      serve({
        'GET posts': new Response('<html>', { status: 200 }),
      });
      const err: InboxPlatformError = await inbox
        .listItems(channel, WINDOW)
        .catch((e) => e);
      expect(err.details).toMatchObject({ unreadable: true, status: 200 });
    });
  });

  describe('getConversation and ownsComment', () => {
    // The checks of a share comment: the post, the comment.
    const shareWorld = (over: Record<string, Route> = {}) =>
      serve({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: SHARE_URN }),
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C1
        ),
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [replyRow('share', SHARE, C1, R1)],
        },
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`]:
          replyRow('share', SHARE, C1, R1),
        ...over,
      });
    const usage = () => new InboxUsageMeter();

    it('reads a share comment without postId: the post, the comment, the replies', async () => {
      shareWorld();
      const conversation = await inbox.getConversation(
        channel,
        SHARE_COMMENT,
        usage()
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call(0).raw).toBe(`${API}/posts/urn%3Ali%3Ashare%3A${SHARE}`);
      expect(call(1).raw).toBe(
        `${API}/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments/${C1}`
      );
      expect(call(0).headers).not.toHaveProperty('X-RestLi-Method');
      expect(conversation!.post).toMatchObject({
        id: SHARE_POST,
        truncated: false,
      });
      expect(
        conversation!.items.map((i) => [i.id, i.parentId, i.postId])
      ).toEqual([
        [SHARE_COMMENT, null, SHARE_POST],
        [SHARE_REPLY, SHARE_COMMENT, SHARE_POST],
      ]);
    });

    it('reads a reply: checks the post, the top comment and the reply, then the thread', async () => {
      shareWorld();
      const conversation = await inbox.getConversation(
        channel,
        SHARE_REPLY,
        usage()
      );
      expect(call(2).raw).toBe(
        `${API}/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29/comments/${R1}`
      );
      expect(conversation!.items.map((i) => i.id)).toEqual([
        SHARE_COMMENT,
        SHARE_REPLY,
      ]);
    });

    it('adds a reply beyond the first page of replies', async () => {
      shareWorld({
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [replyRow('share', SHARE, C1, R2)],
        },
      });
      const conversation = await inbox.getConversation(
        channel,
        SHARE_REPLY,
        usage()
      );
      expect(conversation!.items.map((i) => i.id)).toEqual([
        SHARE_COMMENT,
        `1_${SHARE}_${C1}_${R2}`,
        SHARE_REPLY,
      ]);
    });

    it('reads a ugcPost comment', async () => {
      serve({
        [`GET posts/${UGC_URN}`]: postRow(1, { id: UGC_URN }),
        [`GET socialActions/${UGC_URN}/comments/${C2}`]: commentRow(
          'ugcPost',
          UGC,
          C2
        ),
        [`GET socialActions/${commentUrn('ugcPost', UGC, C2)}/comments`]: {
          elements: [],
        },
      });
      const conversation = await inbox.getConversation(
        channel,
        UGC_COMMENT,
        usage()
      );
      expect(call(0).raw).toBe(`${API}/posts/urn%3Ali%3AugcPost%3A${UGC}`);
      expect(conversation!.post!.id).toBe(UGC_POST);
    });

    it('reads an activity comment with the postId of the post', async () => {
      serve({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: SHARE_URN }),
        [`GET socialActions/${SHARE_URN}/comments/${C3}`]: commentRow(
          'activity',
          ACTIVITY,
          C3
        ),
        [`GET socialActions/${commentUrn('activity', ACTIVITY, C3)}/comments`]:
          {
            elements: [],
          },
      });
      const conversation = await inbox.getConversation(
        channel,
        ACTIVITY_COMMENT,
        usage(),
        SHARE_POST
      );
      expect(conversation!.items).toHaveLength(1);
      expect(conversation!.items[0]).toMatchObject({
        id: ACTIVITY_COMMENT,
        postId: SHARE_POST,
      });
    });

    it.each([
      [
        'getConversation',
        (i: LinkedinInbox, p?: string) =>
          i.getConversation(
            channel,
            ACTIVITY_COMMENT,
            new InboxUsageMeter(),
            p
          ),
      ],
      [
        'ownsComment',
        (i: LinkedinInbox, p?: string) =>
          i.ownsComment(channel, ACTIVITY_COMMENT, p),
      ],
    ])(
      '%s: an activity comment without postId has an unknown owner, without a call',
      async (_name, run) => {
        serve({});
        await expect(run(inbox)).rejects.toBeInstanceOf(
          InboxOwnershipUnknownError
        );
        await expect(run(inbox, '')).rejects.toBeInstanceOf(
          InboxOwnershipUnknownError
        );
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('reads a share comment without postId, the thread tells the post', async () => {
      shareWorld();
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(true);
      expect(await inbox.ownsComment(channel, SHARE_COMMENT, null)).toBe(true);
    });

    it.each([
      ['share', SHARE_COMMENT, UGC_POST],
      ['ugcPost', UGC_COMMENT, SHARE_POST],
      ['share', SHARE_COMMENT, `1_${SHARE}9`],
    ])(
      'a %s comment with a postId that contradicts it has an unknown owner, without a call',
      async (_kind, commentId, postId) => {
        serve({});
        await expect(
          inbox.ownsComment(channel, commentId, postId)
        ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
        await expect(
          inbox.getConversation(channel, commentId, usage(), postId)
        ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it('accepts the postId that agrees with the thread', async () => {
      shareWorld();
      expect(await inbox.ownsComment(channel, SHARE_COMMENT, SHARE_POST)).toBe(
        true
      );
    });

    it.each([
      ['an activity comment with an invalid postId', ACTIVITY_COMMENT, 'x_1'],
      [
        'an activity comment with the activity kind as postId',
        ACTIVITY_COMMENT,
        `0_${ACTIVITY}`,
      ],
      [
        'an activity comment with a postId from a number only',
        ACTIVITY_COMMENT,
        SHARE,
      ],
    ])('%s: ownership is unknown', async (_name, commentId, postId) => {
      serve({});
      await expect(
        inbox.ownsComment(channel, commentId, postId)
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not own a comment of a post of another author', async () => {
      shareWorld({
        [`GET posts/${SHARE_URN}`]: postRow(1, {
          id: SHARE_URN,
          author: FOREIGN_ORG_URN,
        }),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
      expect(
        await inbox.getConversation(channel, SHARE_COMMENT, usage())
      ).toBeNull();
      // the comment is not even asked for
      expect(
        fetchMock.mock.calls.filter(([url]) => url.includes('/comments/'))
      ).toEqual([]);
    });

    it('does not own a post that comes back with another id', async () => {
      shareWorld({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: UGC_URN }),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
    });

    it('does not own a comment that is not under the post', async () => {
      shareWorld({
        // a comment of another thread under the id
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          '7999999999',
          C1
        ),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
    });

    it('does not own a comment whose id differs from the one asked for', async () => {
      shareWorld({
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C2
        ),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
    });

    it('does not own a top-level comment that is a reply itself', async () => {
      shareWorld({
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: replyRow(
          'share',
          SHARE,
          C2,
          C1
        ),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
    });

    it('does not own a reply that is not under its top-level comment', async () => {
      shareWorld({
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`]:
          replyRow('share', SHARE, C1, R2),
      });
      expect(await inbox.ownsComment(channel, SHARE_REPLY)).toBe(false);
    });

    it.each([
      ['the post', `GET posts/${SHARE_URN}`],
      ['the comment', `GET socialActions/${SHARE_URN}/comments/${C1}`],
      [
        'the reply',
        `GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`,
      ],
    ])('answers comment_not_found for a 404 of %s', async (_name, key) => {
      shareWorld({ [key]: notFound() });
      expect(await inbox.ownsComment(channel, SHARE_REPLY)).toBe(false);
      expect(
        await inbox.getConversation(channel, SHARE_REPLY, usage())
      ).toBeNull();
    });

    it('passes on an error that is not a 404', async () => {
      shareWorld({
        [`GET posts/${SHARE_URN}`]: json({ message: 'Forbidden' }, 403),
      });
      await expect(
        inbox.ownsComment(channel, SHARE_COMMENT)
      ).rejects.toMatchObject({ details: { status: 403 } });
    });

    it('rejects an unreadable answer for the post', async () => {
      shareWorld({
        [`GET posts/${SHARE_URN}`]: new Response('', { status: 200 }),
      });
      await expect(
        inbox.ownsComment(channel, SHARE_COMMENT)
      ).rejects.toMatchObject({ details: { unreadable: true } });
    });

    it.each([
      [''],
      ['abc'],
      ['3_1_2'],
      ['1_1'],
      ['1__2'],
      ['1_2_3_4_5'],
      [`1_${'9'.repeat(21)}_1`],
      ['1_1_1_1_'],
      [`../${SHARE_COMMENT}`],
    ])('does not own the invalid comment id %j', async (commentId) => {
      serve({});
      expect(await inbox.ownsComment(channel, commentId)).toBe(false);
      expect(
        await inbox.getConversation(channel, commentId, new InboxUsageMeter())
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reply', () => {
    it('posts to the comments of the top-level comment as the organization', async () => {
      serve({
        [`POST socialActions/${commentUrn('share', SHARE, C1)}/comments`]: json(
          null,
          201,
          { 'x-restli-id': R2 }
        ),
      });
      const result = await inbox.reply(channel, SHARE_COMMENT, 'Danke!');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = call();
      expect(sent.method).toBe('POST');
      expect(sent.raw).toBe(
        `${API}/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29/comments`
      );
      expect(sent.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      });
      expect(sent.body).toEqual({
        actor: ORG_URN,
        object: SHARE_URN,
        message: { text: 'Danke!' },
        parentComment: commentUrn('share', SHARE, C1),
      });
      expect(result).toEqual({ id: `1_${SHARE}_${C1}_${R2}` });
    });

    it('answers a reply with the top-level comment as parent, never the reply', async () => {
      serve({
        [`POST socialActions/${commentUrn('share', SHARE, C1)}/comments`]: json(
          null,
          201,
          { 'x-restli-id': R2 }
        ),
      });
      const result = await inbox.reply(channel, SHARE_REPLY, 'Danke!');

      expect(call().body.parentComment).toBe(commentUrn('share', SHARE, C1));
      expect(call().body.object).toBe(SHARE_URN);
      expect(call().path).toBe(
        `socialActions/${commentUrn('share', SHARE, C1)}/comments`
      );
      expect(result.id).toBe(`1_${SHARE}_${C1}_${R2}`);
    });

    it('replies in a ugcPost thread', async () => {
      serve({
        [`POST socialActions/${commentUrn('ugcPost', UGC, C2)}/comments`]: json(
          null,
          201,
          { 'x-restli-id': R1 }
        ),
      });
      const result = await inbox.reply(channel, UGC_COMMENT, 'Hallo');
      expect(call().raw).toBe(
        `${API}/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3AugcPost%3A${UGC}%2C${C2}%29/comments`
      );
      expect(call().body).toMatchObject({
        object: UGC_URN,
        parentComment: commentUrn('ugcPost', UGC, C2),
      });
      expect(result.id).toBe(`2_${UGC}_${C2}_${R1}`);
    });

    it('replies in an activity thread with the post of the hint as object', async () => {
      serve({
        [`POST socialActions/${commentUrn('activity', ACTIVITY, C3)}/comments`]:
          json(null, 201, { 'x-restli-id': R1 }),
      });
      const result = await inbox.reply(
        channel,
        ACTIVITY_COMMENT,
        'Hallo',
        SHARE_POST
      );
      expect(call().body).toMatchObject({
        object: SHARE_URN,
        parentComment: commentUrn('activity', ACTIVITY, C3),
      });
      expect(result.id).toBe(`0_${ACTIVITY}_${C3}_${R1}`);
    });

    it('answers a null id without x-restli-id, or with an id that is no number', async () => {
      serve({
        [`POST socialActions/${PARENT}/comments`]: json(null, 201),
      });
      expect(await inbox.reply(channel, SHARE_COMMENT, 'a')).toEqual({
        id: null,
      });
      serve({
        [`POST socialActions/${PARENT}/comments`]: json(null, 201, {
          'x-restli-id': 'urn:li:comment:(a,b)',
        }),
      });
      expect(await inbox.reply(channel, SHARE_COMMENT, 'a')).toEqual({
        id: null,
      });
    });

    it('does not call the platform for an activity comment without a post', async () => {
      serve({});
      await expect(
        inbox.reply(channel, ACTIVITY_COMMENT, 'a')
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      await expect(
        inbox.reply(channel, SHARE_COMMENT, 'a', UGC_POST)
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes on a 403 and a 5xx, without the token', async () => {
      serve({
        [`POST socialActions/${PARENT}/comments`]: json(
          { message: 'Forbidden', serviceErrorCode: 100 },
          403
        ),
      });
      const err: InboxPlatformError = await inbox
        .reply(channel, SHARE_COMMENT, 'a')
        .catch((e) => e);
      expect(err.details).toMatchObject({ status: 403, code: 100 });
      expect(JSON.stringify([err.message, err.details])).not.toContain(
        accessToken
      );
      serve({
        [`POST socialActions/${PARENT}/comments`]: json({}, 502),
      });
      await expect(
        inbox.reply(channel, SHARE_COMMENT, 'a')
      ).rejects.toMatchObject({ details: { status: 502 } });
    });
  });

  describe('remove', () => {
    it('deletes a top-level comment under the post, as the organization', async () => {
      serve({
        [`DELETE socialActions/${SHARE_URN}/comments/${C1}`]: json(null, 204),
      });
      await inbox.remove(channel, SHARE_COMMENT);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = call();
      expect(sent.method).toBe('DELETE');
      expect(sent.raw).toBe(
        `${API}/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments/${C1}?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
      expect(sent.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
      });
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    });

    it('deletes a reply under the post, like a top-level comment', async () => {
      serve({
        [`DELETE socialActions/${SHARE_URN}/comments/${R1}`]: json(null, 204),
      });
      await inbox.remove(channel, SHARE_REPLY);
      expect(call().raw).toBe(
        `${API}/socialActions/urn%3Ali%3Ashare%3A${SHARE}/comments/${R1}?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
    });

    it('deletes a ugcPost comment, and an activity comment with the post of the hint', async () => {
      serve({
        [`DELETE socialActions/${UGC_URN}/comments/${C2}`]: json(null, 204),
        [`DELETE socialActions/${UGC_URN}/comments/${C3}`]: json(null, 204),
      });
      await inbox.remove(channel, UGC_COMMENT);
      await inbox.remove(channel, ACTIVITY_COMMENT, UGC_POST);
      expect(call(0).path).toBe(`socialActions/${UGC_URN}/comments/${C2}`);
      expect(call(1).path).toBe(`socialActions/${UGC_URN}/comments/${C3}`);
    });

    it('does not call the platform for an unknown post', async () => {
      serve({});
      await expect(
        inbox.remove(channel, ACTIVITY_COMMENT)
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes on a 404 and a 403', async () => {
      serve({
        [`DELETE socialActions/${SHARE_URN}/comments/${C1}`]: notFound(),
      });
      await expect(inbox.remove(channel, SHARE_COMMENT)).rejects.toMatchObject({
        details: { status: 404 },
      });
      serve({
        [`DELETE socialActions/${SHARE_URN}/comments/${C1}`]: json({}, 403),
      });
      await expect(inbox.remove(channel, SHARE_COMMENT)).rejects.toMatchObject({
        details: { status: 403 },
      });
    });
  });

  describe('like', () => {
    const COMMENT_URN = commentUrn('share', SHARE, C1);

    it('likes a comment as the organization with reactionType LIKE', async () => {
      serve({ 'POST reactions': json(null, 201) });
      await inbox.like(channel, SHARE_COMMENT, true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = call();
      expect(sent.method).toBe('POST');
      expect(sent.raw).toBe(
        `${API}/reactions?actor=urn%3Ali%3Aorganization%3A${ORG}`
      );
      expect(sent.headers).toEqual({
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202611',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      });
      expect(sent.body).toEqual({ root: COMMENT_URN, reactionType: 'LIKE' });
    });

    it('likes a reply with the URN of the reply itself', async () => {
      serve({ 'POST reactions': json(null, 201) });
      await inbox.like(channel, SHARE_REPLY, true);
      expect(call().body.root).toBe(commentUrn('share', SHARE, R1));
    });

    it('takes the like back with the actor and the comment in the path', async () => {
      serve({
        [`DELETE reactions/(actor:${ORG_URN},entity:${COMMENT_URN})`]: json(
          null,
          204
        ),
      });
      await inbox.like(channel, SHARE_COMMENT, false);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = call();
      expect(sent.method).toBe('DELETE');
      expect(sent.raw).toBe(
        `${API}/reactions/(actor:urn%3Ali%3Aorganization%3A${ORG},entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Ashare%3A${SHARE}%2C${C1}%29)`
      );
      expect(sent.headers).not.toHaveProperty('Content-Type');
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    });

    it('likes in an activity thread, with a postId', async () => {
      serve({ 'POST reactions': json(null, 201) });
      await inbox.like(channel, ACTIVITY_COMMENT, true, SHARE_POST);
      expect(call().body.root).toBe(commentUrn('activity', ACTIVITY, C3));
    });

    it('does not call the platform when the owner is unknown', async () => {
      serve({});
      await expect(
        inbox.like(channel, ACTIVITY_COMMENT, true)
      ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('counts a like that is there already (409) as done', async () => {
      serve({ 'POST reactions': json({ message: 'duplicate' }, 409) });
      await expect(
        inbox.like(channel, SHARE_COMMENT, true)
      ).resolves.toBeUndefined();
    });

    it('counts an unlike of none (404) as done', async () => {
      serve({});
      await expect(
        inbox.like(channel, SHARE_COMMENT, false)
      ).resolves.toBeUndefined();
    });

    it.each([
      ['a like with 404', true, 404],
      ['an unlike with 409', false, 409],
      ['a like with 403', true, 403],
      ['an unlike with 403', false, 403],
      ['a like with 429', true, 429],
      ['a like with 500', true, 500],
      ['an unlike with 500', false, 500],
    ])('passes on the error of %s', async (_name, like, status) => {
      serve({
        'POST reactions': json({ message: 'x' }, status),
        [`DELETE reactions/(actor:${ORG_URN},entity:${COMMENT_URN})`]: json(
          { message: 'x' },
          status
        ),
      });
      await expect(
        inbox.like(channel, SHARE_COMMENT, like)
      ).rejects.toMatchObject({ details: { status } });
    });

    it('passes on a network error of a like as unavailable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(
        inbox.like(channel, SHARE_COMMENT, true)
      ).rejects.toMatchObject({ details: { unavailable: true } });
    });
  });

  describe('an answer that is not readable', () => {
    const world = (over: Record<string, Route> = {}) =>
      serve({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: SHARE_URN }),
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C1
        ),
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`]:
          replyRow('share', SHARE, C1, R1),
        ...over,
      });
    const unreadable = { details: { unreadable: true, status: 200 } };

    it.each([
      ['no id', { id: undefined }],
      ['an id that is no text', { id: 7 }],
      ['no author', { author: undefined }],
      ['an author that is no text', { author: { urn: ORG_URN } }],
    ])('is unreadable for a post with %s', async (_name, over) => {
      world({ [`GET posts/${SHARE_URN}`]: postRow(1, over) });
      await expect(
        inbox.ownsComment(channel, SHARE_COMMENT)
      ).rejects.toMatchObject(unreadable);
      await expect(
        inbox.getConversation(channel, SHARE_COMMENT, new InboxUsageMeter())
      ).rejects.toMatchObject(unreadable);
    });

    it.each([
      ['no commentUrn', { commentUrn: undefined }],
      ['a commentUrn that is no text', { commentUrn: 5 }],
      ['a commentUrn of another format', { commentUrn: 'urn:li:comment:x' }],
      [
        'a commentUrn with a leading zero',
        { commentUrn: commentUrn('share', SHARE, `0${C1}`) },
      ],
    ])('is unreadable for a comment with %s', async (_name, over) => {
      world({
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C1,
          over
        ),
      });
      await expect(
        inbox.ownsComment(channel, SHARE_COMMENT)
      ).rejects.toMatchObject(unreadable);
    });

    it.each([
      ['no commentUrn', { commentUrn: undefined }],
      ['a commentUrn of another format', { commentUrn: 'urn:li:comment:x' }],
    ])('is unreadable for a reply with %s', async (_name, over) => {
      world({
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`]:
          replyRow('share', SHARE, C1, R1, over),
      });
      await expect(
        inbox.ownsComment(channel, SHARE_REPLY)
      ).rejects.toMatchObject(unreadable);
    });

    it('is 404 (not found), not unreadable, for the cases of a clear no', async () => {
      // another author, another id, another thread, a comment with a parent
      world({
        [`GET posts/${SHARE_URN}`]: postRow(1, {
          id: SHARE_URN,
          author: FOREIGN_ORG_URN,
        }),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
      world({
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: replyRow(
          'share',
          SHARE,
          C2,
          C1
        ),
      });
      expect(await inbox.ownsComment(channel, SHARE_COMMENT)).toBe(false);
    });
  });

  describe('ids without leading zeros and the short comment URN', () => {
    it.each([['1_007'], ['3_1']])(
      'does not take %j as a post id',
      async (postId) => {
        serve({});
        await expect(
          inbox.ownsComment(channel, ACTIVITY_COMMENT, postId)
        ).rejects.toBeInstanceOf(InboxOwnershipUnknownError);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );

    it.each([
      [`1_007_${C1}`],
      [`1_${SHARE}_0${C1}`],
      [`1_${SHARE}_${C1}_00${R1}`],
      ['1_00_1'],
    ])('does not own the comment id %j, without a call', async (commentId) => {
      serve({});
      expect(await inbox.ownsComment(channel, commentId)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('takes a 0 and a number without a leading zero', async () => {
      serve({
        [`GET posts/urn:li:share:0`]: postRow(1, { id: 'urn:li:share:0' }),
        [`GET socialActions/urn:li:share:0/comments/10`]: commentRow(
          'share',
          '0',
          '10'
        ),
        [`GET socialActions/${commentUrn('share', '0', '10')}/comments`]: {
          elements: [],
        },
      });
      expect(await inbox.ownsComment(channel, '1_0_10')).toBe(true);
    });

    it('reads a comment URN in the short form of the Reactions API', async () => {
      serve({
        'GET posts': { elements: [postRow(1, { id: SHARE_URN })] },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [
            commentRow('share', SHARE, C1, {
              commentUrn: `urn:li:comment:(share:${SHARE},${C1})`,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
            commentRow('activity', ACTIVITY, C2, {
              commentUrn: `urn:li:comment:(activity:${ACTIVITY},${C2})`,
              commentsSummary: { totalFirstLevelComments: 0 },
            }),
          ],
        },
      });
      const { items } = await inbox.listItems(channel, WINDOW);
      expect(items.map((item) => item.id)).toEqual([
        SHARE_COMMENT,
        `0_${ACTIVITY}_${C2}`,
      ]);
    });
  });

  describe('the cost of a conversation', () => {
    it('makes 4 calls for a reply: post, comment, reply, replies', async () => {
      serve({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: SHARE_URN }),
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C1
        ),
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`]:
          replyRow('share', SHARE, C1, R1),
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [replyRow('share', SHARE, C1, R1)],
        },
      });
      await inbox.getConversation(channel, SHARE_REPLY, new InboxUsageMeter());
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls.map((_, i) => call(i).path)).toEqual([
        `posts/${SHARE_URN}`,
        `socialActions/${SHARE_URN}/comments/${C1}`,
        `socialActions/${commentUrn('share', SHARE, C1)}/comments/${R1}`,
        `socialActions/${commentUrn('share', SHARE, C1)}/comments`,
      ]);
    });

    it('makes 3 calls for a top-level comment', async () => {
      serve({
        [`GET posts/${SHARE_URN}`]: postRow(1, { id: SHARE_URN }),
        [`GET socialActions/${SHARE_URN}/comments/${C1}`]: commentRow(
          'share',
          SHARE,
          C1
        ),
        [`GET socialActions/${commentUrn('share', SHARE, C1)}/comments`]: {
          elements: [],
        },
      });
      await inbox.getConversation(
        channel,
        SHARE_COMMENT,
        new InboxUsageMeter()
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('the demo and the budget', () => {
    it('goes on to the next post when one is truncated', async () => {
      serve({
        'GET posts': {
          elements: [
            postRow(1, { id: SHARE_URN }),
            postRow(2, { id: UGC_URN }),
          ],
        },
        [`GET socialActions/${SHARE_URN}/comments`]: {
          elements: [],
          paging: { start: 0, total: 80 },
        },
        [`GET socialActions/${UGC_URN}/comments`]: { elements: [] },
      });
      const posts = await inbox.listComments(channel);
      expect(posts.map((post) => post.id)).toEqual([SHARE_POST, UGC_POST]);
    });
  });

  describe('listComments (the demo)', () => {
    it('lists the latest posts with comments and replies', async () => {
      oneThread();
      const posts = await inbox.listComments(channel);

      expect(call(0).headers['X-RestLi-Method']).toBe('FINDER');
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        id: SHARE_POST,
        commentsCount: 1,
        mediaType: null,
      });
      expect(posts[0].comments[0]).toMatchObject({
        id: SHARE_COMMENT,
        username: null,
        hidden: false,
      });
      expect(posts[0].comments[0].replies.map((r) => r.id)).toEqual([
        SHARE_REPLY,
      ]);
    });

    it('reads only own PUBLISHED posts', async () => {
      serve({
        'GET posts': {
          elements: [
            postRow(1, { id: SHARE_URN, lifecycleState: 'DRAFT' }),
            postRow(2, { id: UGC_URN, author: FOREIGN_ORG_URN }),
          ],
        },
      });
      expect(await inbox.listComments(channel)).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('webhooks', () => {
    it('is not subscribed and makes no call', async () => {
      serve({});
      expect(await inbox.webhookSubscription()).toEqual({
        subscribed: false,
        fields: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cannot subscribe: a platform error, no call', async () => {
      serve({});
      await expect(inbox.subscribeWebhooks()).rejects.toBeInstanceOf(
        InboxPlatformError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('linkedinApi', () => {
  const original = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });
  afterEach(() => {
    global.fetch = original;
  });

  it('sends the token in the header only, never in the URL or the body', async () => {
    fetchMock.mockResolvedValue(json({ elements: [] }));
    await linkedinApi('GET', accessToken, 'posts', { q: 'author' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/posts?q=author`);
    expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(url).not.toContain(accessToken);
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a body as JSON with a content type, and the finder header on request', async () => {
    fetchMock.mockResolvedValue(json(null, 201));
    await linkedinApi(
      'POST',
      accessToken,
      'reactions',
      {},
      {
        body: { a: 1 },
        finder: true,
      }
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/reactions`);
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-RestLi-Method': 'FINDER',
    });
  });

  it('answers the JSON object', async () => {
    fetchMock.mockResolvedValue(json({ elements: [1] }));
    expect(await linkedinApi('GET', accessToken, 'posts')).toEqual({
      answer: { elements: [1] },
      id: null,
    });
  });

  it('answers ok for a 204 without a body', async () => {
    fetchMock.mockResolvedValue(json(null, 204));
    expect(await linkedinApi('DELETE', accessToken, 'x')).toEqual({
      answer: null,
      id: null,
    });
  });

  it('answers ok for a 201 without a body, and reads x-restli-id', async () => {
    fetchMock.mockResolvedValue(json(null, 201, { 'x-restli-id': '12345' }));
    expect(await linkedinApi('POST', accessToken, 'x')).toEqual({
      answer: null,
      id: '12345',
    });
  });

  it.each([['urn:li:comment:(a,b)'], ['12a'], ['-5'], [''], ['1'.repeat(21)]])(
    'takes x-restli-id only with digits, not %j',
    async (value) => {
      fetchMock.mockResolvedValue(json(null, 201, { 'x-restli-id': value }));
      expect((await linkedinApi('POST', accessToken, 'x')).id).toBeNull();
    }
  );

  it('does not take an array or a text as the answer', async () => {
    fetchMock.mockResolvedValue(json([1, 2]));
    expect((await linkedinApi('GET', accessToken, 'x')).answer).toBeNull();
    fetchMock.mockResolvedValue(json('text'));
    expect((await linkedinApi('GET', accessToken, 'x')).answer).toBeNull();
  });

  it('turns a network error into unavailable, without the cause', async () => {
    fetchMock.mockRejectedValue(
      new Error(`connect ECONNREFUSED Bearer ${accessToken}`)
    );
    const err: InboxPlatformError = await linkedinApi(
      'GET',
      accessToken,
      'posts'
    ).catch((e) => e);
    expect(err).toBeInstanceOf(InboxPlatformError);
    expect(err.details).toEqual({ unavailable: true });
    expect(err.message).toBe('platform unavailable');
    expect(JSON.stringify(err)).not.toContain(accessToken);
    expect(err.message).not.toContain(accessToken);
  });

  it('turns a timeout of the request into unavailable', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('x'), { name: 'TimeoutError' })
    );
    await expect(
      linkedinApi('GET', accessToken, 'posts')
    ).rejects.toMatchObject({ details: { unavailable: true } });
  });

  it('turns a timeout while the body is read into unavailable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    });
    await expect(
      linkedinApi('GET', accessToken, 'posts')
    ).rejects.toMatchObject({ details: { unavailable: true } });
  });

  it('takes status, serviceErrorCode and a cleaned message of a 4xx or 5xx', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          status: 403,
          serviceErrorCode: 100,
          message: `Not enough permissions\n Bearer ${accessToken} ?access_token=${accessToken}`,
        },
        403
      )
    );
    const err: InboxPlatformError = await linkedinApi(
      'GET',
      accessToken,
      'posts'
    ).catch((e) => e);
    expect(err.details.unavailable).toBe(false);
    expect(err.details.status).toBe(403);
    expect(err.details.code).toBe(100);
    expect(err.details.reason).toBe(
      'Not enough permissions Bearer *** ?access_token=***'
    );
    expect(JSON.stringify([err.message, err.details])).not.toContain(
      accessToken
    );
  });

  it.each([[400], [401], [404], [409], [429], [500], [503]])(
    'throws a platform error for %i with a body that is no JSON',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('<html>', { status }));
      const err: InboxPlatformError = await linkedinApi(
        'GET',
        accessToken,
        'posts'
      ).catch((e) => e);
      expect(err.details).toEqual({
        unavailable: false,
        status,
        code: undefined,
        reason: undefined,
      });
    }
  );

  it.each([
    ['person', 'urn:li:person:AbC-123_x'],
    ['member', 'urn:li:member:123456'],
  ])('hides the id of a %s in the reason', async (kind, urn) => {
    fetchMock.mockResolvedValue(
      json(
        {
          message: `Actor ${urn} (and ${urn}) is not allowed, org urn:li:organization:5`,
        },
        403
      )
    );
    const err: InboxPlatformError = await linkedinApi(
      'GET',
      accessToken,
      'posts'
    ).catch((e) => e);
    expect(err.details.reason).toBe(
      `Actor urn:li:${kind}:*** (and urn:li:${kind}:***) is not allowed, org urn:li:organization:5`
    );
    expect(err.details.reason).not.toContain(urn);
  });

  it('leaves out a serviceErrorCode that is no number, and a message that is no text', async () => {
    fetchMock.mockResolvedValue(
      json({ serviceErrorCode: '100', message: { a: 1 } }, 400)
    );
    const err: InboxPlatformError = await linkedinApi(
      'GET',
      accessToken,
      'posts'
    ).catch((e) => e);
    expect(err.details.code).toBeUndefined();
    expect(err.details.reason).toBeUndefined();
  });
});
