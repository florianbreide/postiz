// The real PostsService pulls in half of Postiz, some of it ESM-only. The
// retry route gets a stand-in, see ysocial.retry.controller.spec.ts.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

import { randomBytes } from 'crypto';
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
  READ_API_FORBIDDEN_FIELDS,
  YsocialReadRepository,
} from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialReadService } from '../../../../libraries/ysocial/src/read/ysocial.read.service';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';

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

const expectedMedia = [
  { path: 'https://uploads.example.com/2026/10/bild.png', type: 'image' },
  { path: 'https://uploads.example.com/2026/10/clip.mp4', type: 'video' },
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

describe('GET /ysocial/customers, /integrations, /posts, /posts/:id', () => {
  const original = process.env[ENV];
  const repository = {
    getCustomers: jest.fn().mockResolvedValue([customerRow]),
    getIntegrations: jest.fn().mockResolvedValue([integrationRow]),
    getPosts: jest.fn().mockResolvedValue([postRow]),
    getPost: jest.fn(),
    getPostGroup: jest.fn(),
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
      Object.keys(POST_FIELDS).sort()
    );
    expect(body[0].content).toBe(postText);
    expect(body[0].image).toEqual(expectedMedia);
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
      [...Object.keys(POST_FIELDS), 'comments'].sort()
    );
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
      expect(Object.keys(row).sort()).toEqual(Object.keys(POST_FIELDS).sort());
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
      // Of the media only path and type.
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

  it('skips entries without a path and keeps only path and type', async () => {
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
      { path: 'https://uploads.example.com/a.PNG', type: 'image' },
      { path: 'https://uploads.example.com/b.MP4', type: 'video' },
    ]);
  });
});
