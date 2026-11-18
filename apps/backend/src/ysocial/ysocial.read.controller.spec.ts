// The real PostsService pulls in half of Postiz, some of it ESM-only. The
// retry route gets a stand-in, see ysocial.retry.controller.spec.ts.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

import { createHash, randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { format } from 'util';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { YsocialModule } from './ysocial.module';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialRetryService } from '../../../../libraries/ysocial/src/retry/ysocial.retry.service';
import {
  CUSTOMER_FIELDS,
  INTEGRATION_FIELDS,
  POST_FIELDS,
  POST_QUERY_FIELDS,
  READ_API_FORBIDDEN_FIELDS,
  YsocialReadRepository,
} from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialWebhookRepository } from '../../../../libraries/ysocial/src/database/ysocial.webhook.repository';

const ENV = 'YSOCIAL_SERVICE_TOKEN';
const token = randomBytes(32).toString('hex');

// Rows as a careless select would return them: with every secret column.
// The route must still answer only with the fixed fields.
const secrets = {
  token: 'EAAG-fake-token',
  refreshToken: 'fake-refresh-token',
  customInstanceDetails: '{"client_secret":"fake"}',
  settings: '{"post_type":"post"}',
  additionalSettings: '[{"name":"fake-additional"}]',
  internalId: 'page-1',
};

// Post text and media go out for posts only (E52). Invented.
const postText = '<p>Erfundener Posttext für den Test</p>';
const postImage = JSON.stringify([
  {
    id: 'media-1',
    path: 'https://uploads.example.com/2026/10/bild.png',
    alt: 'Erfundener Alt-Text',
  },
  {
    id: 'media-2',
    path: 'https://uploads.example.com/2026/10/clip.mp4',
    thumbnail: 'https://uploads.example.com/2026/10/clip-thumb.jpg',
  },
]);
const content = { content: postText, image: postImage };

const customerRow = {
  id: 'customer-1',
  orgId: 'org-1',
  name: 'Y Social Testkunde',
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-02T08:00:00.000Z'),
  deletedAt: null as Date | null,
  ...secrets,
  ...content,
};

const integrationRow = {
  id: 'int-1',
  organizationId: 'org-1',
  customerId: 'customer-1',
  name: 'Y Social Test',
  customName: null as string | null,
  picture: 'https://example.com/p.png',
  profile: 'ysocial-test',
  providerIdentifier: 'facebook',
  type: 'social',
  disabled: false,
  refreshNeeded: true,
  inBetweenSteps: false,
  tokenExpiration: new Date('2026-12-01T00:00:00.000Z'),
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-02T08:00:00.000Z'),
  ...secrets,
  ...content,
};

const postRow = {
  id: 'post-1',
  organizationId: 'org-1',
  integrationId: 'int-1',
  group: 'g-1',
  parentPostId: null as string | null,
  state: 'ERROR',
  publishDate: new Date('2026-10-27T09:00:00.000Z'),
  intervalInDays: null as number | null,
  releaseURL: null as string | null,
  error: 'failed: https://graph.facebook.com/x?access_token=EAAGsecret',
  createdAt: new Date('2026-10-26T08:00:00.000Z'),
  updatedAt: new Date('2026-10-27T09:01:00.000Z'),
  ...secrets,
  ...content,
};

// Comments of post-1 as Postiz stores them: same group, each one linked to
// the one before (PostsRepository.createOrUpdatePost).
const comment = (id: string, parentPostId: string | null, text: string) => ({
  ...postRow,
  id,
  parentPostId,
  error: null as string | null,
  content: `<p>${text}</p>`,
  image: '[]',
});
const comment1 = comment('post-2', 'post-1', 'Erfundener Kommentar 1');
const comment2 = comment('post-3', 'post-2', 'Erfundener Kommentar 2');

// The media library rows of the two media in postImage (K6).
const mediaRows = [
  {
    id: 'media-1',
    organizationId: 'org-1',
    path: 'https://uploads.example.com/2026/10/bild.png',
    fileSize: 1234,
  },
  {
    id: 'media-2',
    organizationId: 'org-1',
    path: 'https://uploads.example.com/2026/10/clip.mp4',
    fileSize: 56789,
  },
];

const expectedMedia = [
  {
    path: 'https://uploads.example.com/2026/10/bild.png',
    type: 'image',
    size: 1234,
  },
  {
    path: 'https://uploads.example.com/2026/10/clip.mp4',
    type: 'video',
    size: 56789,
  },
];

describe('read API field lists', () => {
  it.each([
    ['customers', CUSTOMER_FIELDS],
    ['integrations', INTEGRATION_FIELDS],
    ['posts', POST_FIELDS],
  ])('the select of %s holds no forbidden field', (_name, fields) => {
    for (const field of [
      'token',
      'refreshToken',
      'settings',
      'customInstanceDetails',
    ]) {
      expect(READ_API_FORBIDDEN_FIELDS).toContain(field);
    }
    for (const field of READ_API_FORBIDDEN_FIELDS) {
      expect(Object.keys(fields)).not.toContain(field);
    }
    expect(Object.values(fields).every((value) => value === true)).toBe(true);
  });

  // Strict on purpose: every new field is a decision of its own and has to
  // be added here (post text and media: E52, PR 36).
  it.each([
    [
      'customers',
      CUSTOMER_FIELDS,
      ['id', 'orgId', 'name', 'createdAt', 'updatedAt'],
    ],
    [
      'integrations',
      INTEGRATION_FIELDS,
      [
        'id',
        'organizationId',
        'customerId',
        'name',
        'customName',
        'picture',
        'profile',
        'providerIdentifier',
        'type',
        'disabled',
        'refreshNeeded',
        'inBetweenSteps',
        'tokenExpiration',
        'createdAt',
        'updatedAt',
      ],
    ],
    [
      'posts',
      POST_FIELDS,
      [
        'id',
        'organizationId',
        'integrationId',
        'group',
        'parentPostId',
        'state',
        'publishDate',
        'intervalInDays',
        'content',
        'image',
        'releaseURL',
        'error',
        'createdAt',
        'updatedAt',
      ],
    ],
  ])(
    'the select of %s holds exactly the agreed fields',
    (_name, fields, keys) => {
      expect(Object.keys(fields)).toEqual(keys);
    }
  );
});

describe('POST_QUERY_FIELDS', () => {
  it('is POST_FIELDS plus exactly settings, the only forbidden field it reads', () => {
    expect(Object.keys(POST_QUERY_FIELDS)).toEqual([
      ...Object.keys(POST_FIELDS),
      'settings',
    ]);
    expect(
      Object.keys(POST_QUERY_FIELDS).filter((field) =>
        READ_API_FORBIDDEN_FIELDS.includes(field as any)
      )
    ).toEqual(['settings']);
    expect(Object.keys(POST_FIELDS)).not.toContain('settings');
    expect(READ_API_FORBIDDEN_FIELDS).toContain('settings');
  });
});

describe('GET /ysocial/customers, /integrations, /posts, /posts/:id', () => {
  const original = process.env[ENV];
  const repository = {
    getCustomers: jest.fn().mockResolvedValue([customerRow]),
    getIntegrations: jest.fn().mockResolvedValue([integrationRow]),
    getPosts: jest.fn().mockResolvedValue([postRow]),
    getPost: jest.fn(),
    getPostGroup: jest.fn(),
    getMedia: jest.fn(),
  };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue(repository)
      .overrideProvider(YsocialRetryRepository)
      .useValue({})
      .overrideProvider(YsocialRetryService)
      .useValue({})
      .overrideProvider(YsocialTokenKeyCheck)
      .useValue({})
      .overrideProvider(YsocialInboxRepository)
      .useValue({})
      .overrideProvider(YsocialWebhookRepository)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Same pipe as apps/backend/src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    process.env[ENV] = token;
  });

  beforeEach(() => {
    repository.getPost.mockReset();
    repository.getPostGroup.mockReset();
    repository.getMedia.mockReset();
    repository.getMedia.mockResolvedValue(mediaRows);
    repository.getPost.mockImplementation(
      async (id: string) =>
        [postRow, comment1, comment2].find((row) => row.id === id) || null
    );
    // Out of order, with a row Postiz detached from the thread.
    repository.getPostGroup.mockResolvedValue([
      comment2,
      { ...comment('post-9', null, 'Abgehängter Kommentar') },
      postRow,
      comment1,
    ]);
  });

  afterAll(async () => {
    await app?.close();
    if (original === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = original;
    }
  });

  const get = (path: string, auth = `Bearer ${token}`) =>
    fetch(`${baseUrl}${path}`, {
      headers: auth ? { authorization: auth } : {},
    });

  const routes = [
    '/ysocial/customers',
    '/ysocial/integrations',
    '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z',
    '/ysocial/posts/post-1',
  ];

  it.each(routes)('%s needs the service token', async (path) => {
    expect((await get(path, '')).status).toBe(401);
    expect(
      (await get(path, `Bearer ${randomBytes(32).toString('hex')}`)).status
    ).toBe(401);
    expect(repository.getPost).not.toHaveBeenCalled();
  });

  it('customers: only the fixed fields', async () => {
    const res = await get('/ysocial/customers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: 'customer-1',
        orgId: 'org-1',
        name: 'Y Social Testkunde',
        createdAt: '2026-10-01T08:00:00.000Z',
        updatedAt: '2026-10-02T08:00:00.000Z',
      },
    ]);
  });

  it('integrations: only the fixed fields and the status', async () => {
    const body = await (await get('/ysocial/integrations')).json();
    expect(Object.keys(body[0]).sort()).toEqual(
      [...Object.keys(INTEGRATION_FIELDS), 'status'].sort()
    );
    expect(body[0]).toMatchObject({
      id: 'int-1',
      customerId: 'customer-1',
      providerIdentifier: 'facebook',
      refreshNeeded: true,
      status: 'refresh_needed',
    });
  });

  it('posts: the fixed fields with text and media, error without credentials', async () => {
    const res = await get(
      '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z'
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body[0]).sort()).toEqual(
      [...Object.keys(POST_FIELDS), 'plug'].sort()
    );
    expect(body[0].plug).toBe(false);
    expect(body[0].content).toBe(postText);
    expect(body[0].image).toEqual(expectedMedia);
    for (const item of body[0].image) {
      expect(Object.keys(item).sort()).toEqual(['path', 'size', 'type']);
    }
    expect(body[0].error).toBe(
      'failed: https://graph.facebook.com/x?access_token=***'
    );
    expect(repository.getPosts).toHaveBeenCalledWith(
      new Date('2026-10-27T00:00:00Z'),
      new Date('2026-10-28T00:00:00Z')
    );
  });

  it('posts/:id: the post and the comments of its thread in order', async () => {
    const res = await get('/ysocial/posts/post-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [...Object.keys(POST_FIELDS), 'plug', 'comments'].sort()
    );
    expect(body.plug).toBe(false);
    expect(body).toMatchObject({
      id: 'post-1',
      parentPostId: null,
      content: postText,
      image: expectedMedia,
      error: 'failed: https://graph.facebook.com/x?access_token=***',
    });
    expect(
      body.comments.map((row: Record<string, unknown>) => [
        row.id,
        row.parentPostId,
        row.content,
        row.image,
      ])
    ).toEqual([
      ['post-2', 'post-1', '<p>Erfundener Kommentar 1</p>', []],
      ['post-3', 'post-2', '<p>Erfundener Kommentar 2</p>', []],
    ]);
    for (const row of body.comments) {
      expect(Object.keys(row).sort()).toEqual(
        [...Object.keys(POST_FIELDS), 'plug'].sort()
      );
    }
    expect(repository.getPost).toHaveBeenCalledWith('post-1');
    expect(repository.getPostGroup).toHaveBeenCalledWith('org-1', 'g-1');
  });

  it('posts/:id of a comment: the comment and the ones after it', async () => {
    const body = await (await get('/ysocial/posts/post-2')).json();
    expect(body.id).toBe('post-2');
    expect(body.comments.map((row: { id: string }) => row.id)).toEqual([
      'post-3',
    ]);
  });

  it('posts/:id without comments: an empty list', async () => {
    repository.getPostGroup.mockResolvedValue([postRow]);
    const body = await (await get('/ysocial/posts/post-1')).json();
    expect(body.comments).toEqual([]);
  });

  it('posts/:id answers 404 for an unknown or deleted post', async () => {
    const res = await get('/ysocial/posts/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, code: 'not_found' });
    expect(repository.getPostGroup).not.toHaveBeenCalled();
  });

  // The read route has one segment after /posts, the retry route two.
  it('posts/:id does not collide with posts/:id/retry', async () => {
    expect((await get('/ysocial/posts/post-1/retry')).status).toBe(404);
    const res = await fetch(`${baseUrl}/ysocial/posts/post-1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(repository.getPost).not.toHaveBeenCalled();
  });

  it('posts: intervalInDays as a number for a repeat post and null without', async () => {
    repository.getPosts.mockResolvedValueOnce([
      { ...postRow, intervalInDays: 7 },
      { ...postRow, id: 'post-2', intervalInDays: null },
    ]);
    const res = await get(
      '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z'
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].intervalInDays).toBe(7);
    expect(body[1].intervalInDays).toBeNull();
    expect(Object.keys(POST_FIELDS)).toContain('intervalInDays');
    expect(Object.keys(body[1])).toContain('intervalInDays');
  });

  // Postiz writes intervalInDays on every post of the group
  // (PostsRepository.createOrUpdatePost), comments carry the post's value.
  it('posts/:id: intervalInDays for the post and its comments', async () => {
    const repeat = { intervalInDays: 7 };
    repository.getPost.mockResolvedValueOnce({ ...postRow, ...repeat });
    repository.getPostGroup.mockResolvedValueOnce([
      { ...comment2, ...repeat },
      { ...postRow, ...repeat },
      { ...comment1, ...repeat },
    ]);
    const body = await (await get('/ysocial/posts/post-1')).json();
    expect(body.intervalInDays).toBe(7);
    expect(
      body.comments.map(
        (row: { intervalInDays: unknown }) => row.intervalInDays
      )
    ).toEqual([7, 7]);
  });

  // plug mirrors PostsService.checkInternalPlug: a key with "plug-" whose
  // third part after split('--') is "integrations", holding a filled array.
  describe('plug', () => {
    const channels = [{ id: 'x' }];
    const plugOf = async (settings: string | null) => {
      repository.getPost.mockResolvedValueOnce({ ...postRow, settings });
      repository.getPostGroup.mockResolvedValueOnce([]);
      const res = await get('/ysocial/posts/post-1');
      expect(res.status).toBe(200);
      return (await res.json()).plug;
    };

    it.each([
      [
        'a filled integrations array',
        JSON.stringify({ 'plug--autoRepostPost--integrations': channels }),
      ],
      [
        'with plug--x--active false beside it, Postiz ignores active',
        JSON.stringify({
          'plug--autoRepostPost--integrations': channels,
          'plug--autoRepostPost--active': false,
        }),
      ],
      [
        'a key with plug- elsewhere in it and integrations as third part',
        JSON.stringify({ 'x-plug-y--z--integrations': channels }),
      ],
      [
        'several plugs, one of them with a channel',
        JSON.stringify({
          'plug--a--integrations': [],
          'plug--a--delay': '5',
          'plug--b--integrations': channels,
        }),
      ],
      [
        'among other settings',
        JSON.stringify({
          post_type: 'post',
          'plug--autoRepostPost--integrations': channels,
        }),
      ],
    ])('is true for %s', async (_name, settings) => {
      expect(await plugOf(settings)).toBe(true);
    });

    it.each([
      ['an empty array', { 'plug--a--integrations': [] }],
      ['no plug key', { post_type: 'post' }],
      ['another third part', { 'plug--x--delay': channels }],
      ['active only', { 'plug--x--active': true }],
      ['a string as integrations', { 'plug--a--integrations': 'x' }],
      ['an object as integrations', { 'plug--a--integrations': { id: 'x' } }],
      ['null as integrations', { 'plug--a--integrations': null }],
      ['integrations without plug-', { 'a--b--integrations': channels }],
      ['integrations as second part', { 'plug--integrations': channels }],
      [
        'several plugs, none with a channel',
        {
          'plug--a--integrations': [],
          'plug--b--delay': '1',
        },
      ],
    ])('is false for %s', async (_name, settings) => {
      expect(await plugOf(JSON.stringify(settings))).toBe(false);
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
      ['broken JSON', '{"plug--a--integrations":[{"id":"x"}'],
      ['a JSON array', '[{"plug--a--integrations":[{"id":"x"}]}]'],
      ['the string "null"', 'null'],
      ['a JSON string', '"plug--a--integrations"'],
      ['a JSON number', '42'],
      ['an empty object', '{}'],
    ])('is false for settings that are %s', async (_name, settings) => {
      expect(await plugOf(settings)).toBe(false);
    });

    // Raw JSON strings on purpose: an object literal with __proto__ would
    // not create the key.
    it.each([
      [
        'the third part',
        '{"plug--x--__proto__":{"integrations":[{"id":"a"}]}}',
      ],
      ['the second part', '{"plug--__proto__--integrations":[{"id":"a"}]}'],
      [
        'the second part with another third part',
        '{"plug--__proto__--delay":"1"}',
      ],
    ])('is true when a part named __proto__ is %s', async (_name, settings) => {
      expect(await plugOf(settings)).toBe(true);
      expect(({} as Record<string, unknown>).integrations).toBeUndefined();
      expect(({} as Record<string, unknown>).delay).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
    });

    it('is false for a part named __proto__ in a key without plug-', async () => {
      expect(await plugOf('{"a--__proto__--integrations":[1]}')).toBe(false);
      expect(({} as Record<string, unknown>).integrations).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
    });

    it('lists and comments carry plug per row, never settings', async () => {
      const settings = JSON.stringify({
        'plug--erfundenPlug--integrations': [{ id: 'erfunden-kanal-1' }],
        'plug--erfundenPlug--delay': 'erfundene-verzoegerung',
        'plug--erfundenPlug--post': 'erfundener-plug-text',
      });
      repository.getPosts.mockResolvedValueOnce([
        { ...postRow, settings },
        { ...postRow, id: 'post-5', settings: '{}' },
      ]);
      const list = await (
        await get(
          '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z'
        )
      ).text();
      const rows = JSON.parse(list);
      expect(rows.map((row: { plug: boolean }) => row.plug)).toEqual([
        true,
        false,
      ]);

      repository.getPost.mockResolvedValueOnce({ ...postRow, settings });
      repository.getPostGroup.mockResolvedValueOnce([
        { ...postRow, settings },
        { ...comment1, settings },
        { ...comment2, settings: '{}' },
      ]);
      const one = await (await get('/ysocial/posts/post-1')).text();
      const body = JSON.parse(one);
      expect(body.plug).toBe(true);
      expect(body.comments.map((row: { plug: boolean }) => row.plug)).toEqual([
        true,
        false,
      ]);

      for (const text of [list, one]) {
        expect(text).not.toContain('"settings"');
        for (const part of [
          'plug--',
          'erfundenPlug',
          'erfunden-kanal-1',
          'erfundene-verzoegerung',
          'erfundener-plug-text',
          'post_type',
        ]) {
          expect(text).not.toContain(part);
        }
      }
    });
  });

  // Size and sha256 of a medium (K6).
  describe('size and sha256', () => {
    const listPath =
      '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z';
    const names = ['FRONTEND_URL', 'UPLOAD_DIRECTORY', 'STORAGE_PROVIDER'];
    const saved: Record<string, string | undefined> = {};
    let directory: string;
    const base = 'https://hub.example.test';

    beforeEach(() => {
      for (const name of names) {
        saved[name] = process.env[name];
      }
      directory = mkdtempSync(join(tmpdir(), 'ysocial-read-'));
      process.env.FRONTEND_URL = base;
      process.env.UPLOAD_DIRECTORY = directory;
      delete process.env.STORAGE_PROVIDER;
    });

    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
      rmSync(directory, { recursive: true, force: true });
    });

    const withImage = (row: typeof postRow, image: object[]) => ({
      ...row,
      image: JSON.stringify(image),
    });

    it('posts: size of every medium, never sha256, one query', async () => {
      const body = await (await get(listPath)).json();
      expect(body[0].image).toEqual(expectedMedia);
      expect(JSON.stringify(body)).not.toContain('sha256');
      expect(repository.getMedia).toHaveBeenCalledTimes(1);
      expect(repository.getMedia).toHaveBeenCalledWith(['media-1', 'media-2']);
    });

    it('posts: one query for all posts, with deduplicated ids', async () => {
      repository.getPosts.mockResolvedValueOnce([
        postRow,
        { ...postRow, id: 'post-5' },
        withImage(postRow, [
          { id: 'media-2', path: mediaRows[1].path },
          { id: 'media-3', path: 'https://uploads.example.com/c.png' },
        ]),
      ]);
      await get(listPath);
      expect(repository.getMedia).toHaveBeenCalledTimes(1);
      expect(repository.getMedia).toHaveBeenCalledWith([
        'media-1',
        'media-2',
        'media-3',
      ]);
    });

    it('posts: no query when no medium has an id', async () => {
      repository.getPosts.mockResolvedValueOnce([
        withImage(postRow, [{ path: mediaRows[0].path }]),
        { ...postRow, id: 'post-5', image: '[]' },
        { ...postRow, id: 'post-6', image: null },
      ]);
      const body = await (await get(listPath)).json();
      expect(repository.getMedia).not.toHaveBeenCalled();
      expect(body[0].image).toEqual([
        { path: mediaRows[0].path, type: 'image', size: null },
      ]);
    });

    it.each([
      ['another organization', { organizationId: 'org-2' }],
      ['another path', { path: 'https://uploads.example.com/other.png' }],
      ['a file size of 0', { fileSize: 0 }],
    ])('posts: size is null for %s', async (_name, change) => {
      repository.getMedia.mockResolvedValue([
        { ...mediaRows[0], ...change },
        mediaRows[1],
      ]);
      const body = await (await get(listPath)).json();
      expect(body[0].image[0].size).toBeNull();
      expect(body[0].image[1].size).toBe(56789);
    });

    it('posts: size is null when the id has no row', async () => {
      repository.getMedia.mockResolvedValue([mediaRows[1]]);
      const body = await (await get(listPath)).json();
      expect(body[0].image[0].size).toBeNull();
      expect(body[0].image[1].size).toBe(56789);
    });

    it('posts: size is null for a medium without an id in the JSON', async () => {
      repository.getPosts.mockResolvedValueOnce([
        withImage(postRow, [
          { path: mediaRows[0].path },
          { id: 'media-2', path: mediaRows[1].path },
        ]),
      ]);
      const body = await (await get(listPath)).json();
      expect(body[0].image.map((item: any) => item.size)).toEqual([
        null,
        56789,
      ]);
      expect(repository.getMedia).toHaveBeenCalledWith(['media-2']);
    });

    it('posts: id, alt and thumbnail stay out of the answer', async () => {
      const text = await (await get(listPath)).text();
      expect(text).not.toContain('"id":"media-');
      expect(text).not.toContain('"alt"');
      expect(text).not.toContain('"thumbnail"');
      expect(text).not.toContain('clip-thumb');
    });

    it('posts/:id: size, and no sha256 field without ?media=sha256, one query', async () => {
      const commentWithMedia = {
        ...comment1,
        image: JSON.stringify([{ id: 'media-1', path: mediaRows[0].path }]),
      };
      repository.getPostGroup.mockResolvedValue([
        postRow,
        commentWithMedia,
        comment2,
      ]);
      const body = await (await get('/ysocial/posts/post-1')).json();
      expect(body.image.map((item: any) => item.size)).toEqual([1234, 56789]);
      expect(body.comments[0].image).toEqual([
        { path: mediaRows[0].path, type: 'image', size: 1234 },
      ]);
      expect(JSON.stringify(body)).not.toContain('sha256');
      expect(repository.getMedia).toHaveBeenCalledTimes(1);
      expect(repository.getMedia).toHaveBeenCalledWith(['media-1', 'media-2']);
    });

    it.each([
      ['media=md5'],
      ['media='],
      ['media=SHA256'],
      ['media=sha256&media=md5'],
    ])('posts/:id?%s answers 400', async (query) => {
      const res = await get(`/ysocial/posts/post-1?${query}`);
      expect(res.status).toBe(400);
      expect(repository.getPost).not.toHaveBeenCalled();
    });

    it('posts/:id?media=sha256 needs the service token', async () => {
      expect((await get('/ysocial/posts/post-1?media=sha256', '')).status).toBe(
        401
      );
    });

    it('posts/:id: size of the file in the upload folder for fileSize 0', async () => {
      writeFileSync(join(directory, 'null.png'), Buffer.alloc(77));
      const path = `${base}/uploads/null.png`;
      repository.getMedia.mockResolvedValue([
        { ...mediaRows[0], path, fileSize: 0 },
      ]);
      repository.getPost.mockResolvedValue({
        ...postRow,
        image: JSON.stringify([{ id: 'media-1', path }]),
      });
      repository.getPostGroup.mockResolvedValue([]);
      const body = await (await get('/ysocial/posts/post-1')).json();
      expect(body.image).toEqual([{ path, type: 'image', size: 77 }]);
    });

    it('posts/:id: sha256 of the files in the upload folder, for post and comments', async () => {
      mkdirSync(join(directory, '2026'));
      const bytes = Buffer.from('erfundene Bilddaten');
      writeFileSync(join(directory, '2026', 'bild.png'), bytes);
      writeFileSync(join(directory, '2026', 'clip.mp4'), 'erfundenes Video');
      const url = (name: string) => `${base}/uploads/2026/${name}`;
      const rows = [
        { ...mediaRows[0], path: url('bild.png') },
        { ...mediaRows[1], path: url('clip.mp4') },
      ];
      repository.getMedia.mockResolvedValue(rows);
      const image = JSON.stringify([
        { id: 'media-1', path: rows[0].path },
        { id: 'media-2', path: rows[1].path },
        { id: 'media-1', path: url('fehlt.png') },
      ]);
      repository.getPost.mockResolvedValue({ ...postRow, image });
      repository.getPostGroup.mockResolvedValue([
        { ...postRow, image },
        { ...comment1, image },
      ]);
      const res = await get('/ysocial/posts/post-1?media=sha256');
      expect(res.status).toBe(200);
      const body = await res.json();
      const sha = (value: string | Buffer) =>
        createHash('sha256').update(value).digest('hex');
      const expected = [
        { path: rows[0].path, type: 'image', size: 1234, sha256: sha(bytes) },
        {
          path: rows[1].path,
          type: 'video',
          size: 56789,
          sha256: sha('erfundenes Video'),
        },
        // Not the file of this path in the library: no size, no file.
        { path: url('fehlt.png'), type: 'image', size: null, sha256: null },
      ];
      expect(body.image).toEqual(expected);
      expect(body.comments[0].image).toEqual(expected);
    });

    it('posts/:id: sha256 is null for a medium outside the local storage', async () => {
      process.env.STORAGE_PROVIDER = 'cloudflare';
      const body = await (
        await get('/ysocial/posts/post-1?media=sha256')
      ).json();
      expect(body.image.map((item: any) => item.sha256)).toEqual([null, null]);
      expect(body.image.map((item: any) => item.size)).toEqual([1234, 56789]);
    });
  });

  it('no route ever answers with a forbidden field or a secret value', async () => {
    for (const path of routes) {
      const text = await (await get(path)).text();
      for (const field of READ_API_FORBIDDEN_FIELDS) {
        expect(text).not.toContain(`"${field}"`);
      }
      for (const value of Object.values(secrets)) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toContain('EAAGsecret');
      // Of the media only path, type and size (sha256 on one post).
      expect(text).not.toContain('media-1');
      expect(text).not.toContain('Erfundener Alt-Text');
      expect(text).not.toContain('clip-thumb.jpg');
    }
  });

  it('customers and integrations never answer with post text or media', async () => {
    for (const path of ['/ysocial/customers', '/ysocial/integrations']) {
      const text = await (await get(path)).text();
      expect(text).not.toContain('Erfundener Posttext');
      expect(text).not.toContain('uploads.example.com');
    }
  });

  it('the post text never reaches the log', async () => {
    const spies = [
      ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map(
        (level) => jest.spyOn(Logger.prototype, level)
      ),
      ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map(
        (level) => jest.spyOn(Logger, level)
      ),
      ...(['log', 'info', 'error', 'warn', 'debug'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation(() => undefined)
      ),
    ];
    try {
      await get(
        '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z'
      );
      await get('/ysocial/posts/post-1');
      await get('/ysocial/posts/unknown');
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => format(...args))
        .join('\n');
      expect(logged).not.toContain('Erfundener');
      expect(logged).not.toContain('uploads.example.com');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it.each([
    ['without from and to', '/ysocial/posts'],
    [
      'with a date that is not ISO 8601',
      '/ysocial/posts?from=yesterday&to=today',
    ],
    [
      'with to before from',
      '/ysocial/posts?from=2026-10-28T00:00:00Z&to=2026-10-27T00:00:00Z',
    ],
    [
      'with more than 31 days',
      '/ysocial/posts?from=2026-09-01T00:00:00Z&to=2026-10-28T00:00:00Z',
    ],
  ])('posts answers 400 %s', async (_name, path) => {
    expect((await get(path)).status).toBe(400);
  });
});

describe('media of a post', () => {
  const postWithImage = (image: string | null) => ({
    ...postRow,
    image,
  });
  const imageOf = async (image: string | null) => {
    const service = new YsocialReadService({
      getPosts: jest.fn().mockResolvedValue([postWithImage(image)]),
      getMedia: jest.fn().mockResolvedValue([]),
    } as unknown as YsocialReadRepository);
    const [post] = await service.getPosts(
      '2026-10-27T00:00:00Z',
      '2026-10-28T00:00:00Z'
    );
    return post.image;
  };

  it.each([
    ['no media', null],
    ['an empty string', ''],
    ['JSON that does not parse', '[{"path":'],
    ['JSON that is not a list', '{"path":"https://uploads.example.com/a.png"}'],
    ['the string "undefined"', 'undefined'],
  ])('%s gives an empty list', async (_name, image) => {
    expect(await imageOf(image)).toEqual([]);
  });

  it('skips entries without a path and keeps only path, type and size', async () => {
    expect(
      await imageOf(
        JSON.stringify([
          null,
          { id: 'media-1' },
          { path: '' },
          { path: 42 },
          {
            id: 'media-2',
            path: 'https://uploads.example.com/a.PNG',
            alt: 'x',
          },
          { path: 'https://uploads.example.com/b.MP4' },
        ])
      )
    ).toEqual([
      { path: 'https://uploads.example.com/a.PNG', type: 'image', size: null },
      { path: 'https://uploads.example.com/b.MP4', type: 'video', size: null },
    ]);
  });
});

describe('thread order of the comments', () => {
  const thread = async (group: Array<Record<string, unknown>>) => {
    const service = new YsocialReadService({
      getPost: jest.fn().mockResolvedValue(postRow),
      getPostGroup: jest.fn().mockResolvedValue(group),
      getMedia: jest.fn().mockResolvedValue([]),
    } as unknown as YsocialReadRepository);
    const body = await service.getPost('post-1');
    return body.comments.map((row) => row.id);
  };

  // The requested post itself sits in the cycle, so the walk would come
  // back to it without the guard.
  it('ends on a cycle instead of hanging', async () => {
    // post-1 -> post-2 -> post-3 -> post-1 ...
    expect(
      await thread([
        { ...postRow, parentPostId: 'post-3' },
        comment('post-2', 'post-1', 'a'),
        comment('post-3', 'post-2', 'b'),
      ])
    ).toEqual(['post-2', 'post-3']);
  });

  it('ends when the post points at itself', async () => {
    expect(await thread([{ ...postRow, parentPostId: 'post-1' }])).toEqual([]);
  });

  // The repository sorts the group by createdAt and id, the oldest child
  // counts. Postiz loads childrenPost without an order, so this is our
  // fixed choice for a state that only exists briefly while saving.
  it('follows the first of two comments on the same parent', async () => {
    expect(
      await thread([
        postRow,
        comment('post-2', 'post-1', 'first'),
        comment('post-3', 'post-1', 'second'),
        comment('post-4', 'post-3', 'third'),
      ])
    ).toEqual(['post-2']);
    expect(
      await thread([
        postRow,
        comment('post-3', 'post-1', 'second'),
        comment('post-4', 'post-3', 'third'),
        comment('post-2', 'post-1', 'first'),
      ])
    ).toEqual(['post-3', 'post-4']);
  });
});
