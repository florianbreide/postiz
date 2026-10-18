import { randomBytes } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { YsocialModule } from './ysocial.module';
import {
  CUSTOMER_FIELDS,
  INTEGRATION_FIELDS,
  POST_FIELDS,
  READ_API_FORBIDDEN_FIELDS,
  YsocialReadRepository,
} from '../../../../libraries/ysocial/src/database/ysocial.read.repository';

const ENV = 'YSOCIAL_SERVICE_TOKEN';
const token = randomBytes(32).toString('hex');

// Rows as a careless select would return them: with every secret column.
// The route must still answer only with the fixed fields.
const secrets = {
  token: 'EAAG-fake-token',
  refreshToken: 'fake-refresh-token',
  customInstanceDetails: '{"client_secret":"fake"}',
  settings: '{"post_type":"post"}',
  content: 'Erfundener Posttext',
  image: '[{"path":"/uploads/x.png"}]',
  additionalSettings: '[]',
  internalId: 'page-1',
};

const customerRow = {
  id: 'customer-1',
  orgId: 'org-1',
  name: 'Y Social Testkunde',
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  updatedAt: new Date('2026-10-02T08:00:00.000Z'),
  deletedAt: null as Date | null,
  ...secrets,
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
};

describe('read API field lists', () => {
  it.each([
    ['customers', CUSTOMER_FIELDS],
    ['integrations', INTEGRATION_FIELDS],
    ['posts', POST_FIELDS],
  ])('the select of %s holds no forbidden field', (_name, fields) => {
    for (const field of READ_API_FORBIDDEN_FIELDS) {
      expect(Object.keys(fields)).not.toContain(field);
    }
    expect(Object.values(fields).every((value) => value === true)).toBe(true);
  });
});

describe('GET /ysocial/customers, /integrations, /posts', () => {
  const original = process.env[ENV];
  const repository = {
    getCustomers: jest.fn().mockResolvedValue([customerRow]),
    getIntegrations: jest.fn().mockResolvedValue([integrationRow]),
    getPosts: jest.fn().mockResolvedValue([postRow]),
  };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue(repository)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Same pipe as apps/backend/src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    process.env[ENV] = token;
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

  it.each([
    '/ysocial/customers',
    '/ysocial/integrations',
    '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z',
  ])('%s needs the service token', async (path) => {
    expect((await get(path, '')).status).toBe(401);
    expect(
      (await get(path, `Bearer ${randomBytes(32).toString('hex')}`)).status
    ).toBe(401);
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

  it('posts: only the fixed fields, error without credentials', async () => {
    const res = await get(
      '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z'
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body[0]).sort()).toEqual(
      Object.keys(POST_FIELDS).sort()
    );
    expect(body[0].error).toBe(
      'failed: https://graph.facebook.com/x?access_token=***'
    );
    expect(repository.getPosts).toHaveBeenCalledWith(
      new Date('2026-10-27T00:00:00Z'),
      new Date('2026-10-28T00:00:00Z')
    );
  });

  it('no route ever answers with a forbidden field or a secret value', async () => {
    for (const path of [
      '/ysocial/customers',
      '/ysocial/integrations',
      '/ysocial/posts?from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z',
    ]) {
      const text = await (await get(path)).text();
      for (const field of READ_API_FORBIDDEN_FIELDS) {
        expect(text).not.toContain(`"${field}"`);
      }
      for (const value of Object.values(secrets)) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toContain('EAAGsecret');
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
