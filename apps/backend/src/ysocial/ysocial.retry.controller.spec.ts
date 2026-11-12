// The real PostsService pulls in half of Postiz, some of it ESM-only.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import { randomBytes } from 'crypto';
import {
  Global,
  INestApplication,
  Logger,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { YsocialModule } from './ysocial.module';
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialRetryService } from '../../../../libraries/ysocial/src/retry/ysocial.retry.service';

const ENV = 'YSOCIAL_SERVICE_TOKEN';
const token = randomBytes(32).toString('hex');
const ACTOR = 'anna@example.com';
const CONTENT = 'Erfundener Posttext, der nie im Log stehen darf';

const postRow = (patch: Record<string, unknown> = {}, channel = {}): any => ({
  id: 'post-1',
  organizationId: 'org-1',
  state: 'ERROR',
  deletedAt: null,
  parentPostId: null,
  releaseURL: null,
  error: 'No Post',
  content: CONTENT,
  ...patch,
  integration: {
    providerIdentifier: 'facebook',
    disabled: false,
    refreshNeeded: false,
    inBetweenSteps: false,
    deletedAt: null,
    ...channel,
  },
});

// A platform that records every property read. YsocialRetryService only gets
// the repository and PostsService, so it has no way to reach a provider. The
// app still offers the platform through IntegrationManager, so the check
// fails if the retry path ever starts to use it.
const providerAccess: string[] = [];
const recordingProvider = new Proxy(
  {},
  {
    get(_obj, prop) {
      providerAccess.push(String(prop));
      return () => {
        throw new Error(`provider.${String(prop)} must not be called`);
      };
    },
  }
);

const repository = {
  getPostForRetry: jest.fn(),
  queueFailedPost: jest.fn(),
};
const postsService = { startWorkflow: jest.fn() };
const integrationManager = {
  getSocialIntegration: jest.fn(() => recordingProvider),
};

const asyncIterable = (items: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* items;
  },
});
const workflowList = jest.fn();
const temporalService: any = {
  client: { getRawClient: jest.fn() },
};

// Stand-ins for what the Global DatabaseModule of Postiz provides.
@Global()
@Module({
  providers: [
    { provide: PostsService, useValue: postsService },
    { provide: IntegrationManager, useValue: integrationManager },
    { provide: TemporalService, useValue: temporalService },
  ],
  exports: [PostsService, IntegrationManager, TemporalService],
})
class PostsServiceTestModule {}

describe('POST /ysocial/posts/:id/retry', () => {
  const original = process.env[ENV];
  let app: INestApplication;
  let baseUrl: string;
  let logs: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PostsServiceTestModule, YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue({})
      .overrideProvider(YsocialRetryRepository)
      .useValue(repository)
      .overrideProvider(YsocialTokenKeyCheck)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Same pipe as apps/backend/src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (original === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = original;
    }
  });

  beforeEach(() => {
    process.env[ENV] = token;
    jest.clearAllMocks();
    providerAccess.length = 0;
    repository.getPostForRetry.mockResolvedValue(postRow());
    repository.queueFailedPost.mockResolvedValue(true);
    postsService.startWorkflow.mockResolvedValue(undefined);
    workflowList.mockImplementation(() => asyncIterable([]));
    temporalService.client.getRawClient.mockReturnValue({
      workflow: { list: workflowList },
    });
    logs = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logs.mockRestore();
    // The platform is never touched, whatever the case.
    expect(providerAccess).toEqual([]);
    expect(integrationManager.getSocialIntegration).not.toHaveBeenCalled();
  });

  const retry = (
    id = 'post-1',
    {
      auth = `Bearer ${token}`,
      actor = ACTOR as string | null,
      body,
    }: { auth?: string; actor?: string | null; body?: unknown } = {}
  ) =>
    fetch(`${baseUrl}/ysocial/posts/${id}/retry`, {
      method: 'POST',
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(actor ? { 'x-ysocial-actor': actor } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });

  const nothingStarted = () => {
    expect(postsService.startWorkflow).not.toHaveBeenCalled();
    expect(repository.queueFailedPost).not.toHaveBeenCalled();
  };

  describe('auth', () => {
    it('answers 401 without or with a wrong token', async () => {
      expect((await retry('post-1', { auth: '' })).status).toBe(401);
      expect(
        (
          await retry('post-1', {
            auth: `Bearer ${randomBytes(32).toString('hex')}`,
          })
        ).status
      ).toBe(401);
      expect(repository.getPostForRetry).not.toHaveBeenCalled();
      nothingStarted();
    });

    it('answers 503 without a configured token', async () => {
      delete process.env[ENV];
      expect((await retry()).status).toBe(503);
      expect(repository.getPostForRetry).not.toHaveBeenCalled();
      nothingStarted();
    });
  });

  describe('actor', () => {
    it('answers 400 actor_missing without X-Ysocial-Actor', async () => {
      const res = await retry('post-1', { actor: null });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'actor_missing' });
      expect(repository.getPostForRetry).not.toHaveBeenCalled();
      nothingStarted();
    });

    it('answers 400 actor_missing for an actor with spaces only', async () => {
      const res = await retry('post-1', { actor: '   ' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'actor_missing' });
      nothingStarted();
    });
  });

  describe('safe error', () => {
    it('answers 202 and starts the workflow exactly once', async () => {
      const res = await retry();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ id: 'post-1', state: 'QUEUE' });
      expect(repository.queueFailedPost).toHaveBeenCalledTimes(1);
      expect(repository.queueFailedPost).toHaveBeenCalledWith('post-1');
      expect(postsService.startWorkflow).toHaveBeenCalledTimes(1);
      expect(postsService.startWorkflow).toHaveBeenCalledWith(
        'facebook',
        'post-1',
        'org-1',
        'QUEUE'
      );
    });

    it('derives the task queue from the provider (instagram-standalone -> instagram)', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({}, { providerIdentifier: 'instagram-standalone' })
      );
      expect((await retry()).status).toBe(202);
      expect(postsService.startWorkflow).toHaveBeenCalledWith(
        'instagram',
        'post-1',
        'org-1',
        'QUEUE'
      );
    });

    it('queues before it starts the workflow', async () => {
      const order: string[] = [];
      repository.queueFailedPost.mockImplementation(async () => {
        order.push('queue');
        return true;
      });
      postsService.startWorkflow.mockImplementation(async () => {
        order.push('start');
      });
      await retry();
      expect(order).toEqual(['queue', 'start']);
    });
  });

  describe('what the service can reach (rule 10)', () => {
    it('gets only the repository, PostsService and TemporalService', () => {
      // No IntegrationManager and no provider: a changed constructor fails here.
      expect(
        Reflect.getMetadata('design:paramtypes', YsocialRetryService)
      ).toEqual([YsocialRetryRepository, PostsService, TemporalService]);
    });
  });

  describe('running workflow', () => {
    const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];

    it('asks Temporal for a running workflow of this post, before queue and start', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ id: 'post-db-7' })
      );
      expect((await retry('path-id')).status).toBe(202);
      expect(workflowList).toHaveBeenCalledTimes(1);
      expect(workflowList).toHaveBeenCalledWith({
        query: 'postId="post-db-7" AND ExecutionStatus="Running"',
      });
      expect(order(workflowList)).toBeLessThan(
        order(repository.queueFailedPost)
      );
      expect(order(repository.queueFailedPost)).toBeLessThan(
        order(postsService.startWorkflow)
      );
    });

    it('409 workflow_running when a workflow runs', async () => {
      workflowList.mockImplementation(() => asyncIterable([{ id: 'wf-1' }]));
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'workflow_running' });
      nothingStarted();
    });

    it.each([
      [
        'list throws',
        () =>
          workflowList.mockImplementation(() => {
            throw new Error('unavailable');
          }),
      ],
      [
        'list fails while iterating',
        () =>
          workflowList.mockImplementation(() => ({
            async *[Symbol.asyncIterator]() {
              throw new Error('stream broke');
              yield 1;
            },
          })),
      ],
      [
        'getRawClient is undefined',
        () => temporalService.client.getRawClient.mockReturnValue(undefined),
      ],
    ])('503 temporal_unavailable when %s', async (_n, setup) => {
      setup();
      const res = await retry();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'temporal_unavailable' });
      nothingStarted();
    });

    it.each([
      [
        'unknown post',
        404,
        'not_found',
        () => repository.getPostForRetry.mockResolvedValue(null),
      ],
      [
        'a post in QUEUE',
        409,
        'already_queued',
        () =>
          repository.getPostForRetry.mockResolvedValue(
            postRow({ state: 'QUEUE' })
          ),
      ],
      [
        'a channel that needs a refresh',
        409,
        'channel_inactive',
        () =>
          repository.getPostForRetry.mockResolvedValue(
            postRow({}, { refreshNeeded: true })
          ),
      ],
    ])('does not ask Temporal for %s', async (_n, status, code, setup) => {
      setup();
      const res = await retry();
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
      expect(workflowList).not.toHaveBeenCalled();
      expect(temporalService.client.getRawClient).not.toHaveBeenCalled();
    });

    // Nobody should confirm "not online" while Postiz may still publish.
    it('answers workflow_running before it asks for a confirmation', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ error: 'socket hang up' })
      );
      workflowList.mockImplementation(() => asyncIterable([{ id: 'wf-1' }]));
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'workflow_running' });
      nothingStarted();
    });

    it('asks Temporal before it answers unclear_outcome', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ error: 'socket hang up' })
      );
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'unclear_outcome' });
      expect(workflowList).toHaveBeenCalledTimes(1);
      nothingStarted();
    });

    it('logs the rejection codes', async () => {
      workflowList.mockImplementation(() => asyncIterable([{}]));
      await retry();
      expect(logs.mock.calls.flat().join('\n')).toContain(
        'rejected code=workflow_running'
      );
    });
  });

  describe('rejected', () => {
    it('404 for an unknown post', async () => {
      repository.getPostForRetry.mockResolvedValue(null);
      const res = await retry('nope');
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
      nothingStarted();
    });

    it('409 already_queued for a post in QUEUE', async () => {
      repository.getPostForRetry.mockResolvedValue(postRow({ state: 'QUEUE' }));
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'already_queued' });
      nothingStarted();
    });

    it('409 not_failed for a PUBLISHED post', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ state: 'PUBLISHED' })
      );
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'not_failed',
        state: 'PUBLISHED',
      });
      nothingStarted();
    });

    it('409 not_first_post for a comment', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ parentPostId: 'post-0' })
      );
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'not_first_post' });
      nothingStarted();
    });

    it('409 deleted for a deleted post', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ deletedAt: new Date() })
      );
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'deleted' });
      nothingStarted();
    });

    it.each([
      ['disabled', { disabled: true }],
      ['refresh_needed', { refreshNeeded: true }],
      ['in_between_steps', { inBetweenSteps: true }],
      ['deleted', { deletedAt: new Date() }],
    ])(
      '409 channel_inactive for a channel that is %s',
      async (flag, channel) => {
        repository.getPostForRetry.mockResolvedValue(postRow({}, channel));
        const res = await retry();
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
          code: 'channel_inactive',
          flag,
        });
        nothingStarted();
      }
    );

    it('409 state_changed when queueFailedPost loses the race, no workflow', async () => {
      repository.queueFailedPost.mockResolvedValue(false);
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'state_changed' });
      expect(repository.queueFailedPost).toHaveBeenCalledTimes(1);
      expect(postsService.startWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('unclear outcome', () => {
    beforeEach(() => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ error: 'Could not confirm the post status' })
      );
    });

    it('409 unclear_outcome without confirmUnclear', async () => {
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'unclear_outcome',
        reason: 'unconfirmed',
      });
      nothingStarted();
    });

    it('409 unclear_outcome with confirmUnclear false', async () => {
      const res = await retry('post-1', { body: { confirmUnclear: false } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'unclear_outcome' });
      nothingStarted();
    });

    it('409 with reason published when a releaseURL is set', async () => {
      repository.getPostForRetry.mockResolvedValue(
        postRow({ releaseURL: 'https://example.com/ysocial-test/1' })
      );
      const res = await retry();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'unclear_outcome',
        reason: 'published',
      });
      nothingStarted();
    });

    it('202 and exactly one start with confirmUnclear true', async () => {
      const res = await retry('post-1', { body: { confirmUnclear: true } });
      expect(res.status).toBe(202);
      expect(postsService.startWorkflow).toHaveBeenCalledTimes(1);
      expect(repository.queueFailedPost).toHaveBeenCalledTimes(1);
      expect(logs.mock.calls.flat().join('\n')).toContain(
        'confirmed=unconfirmed'
      );
    });

    it('400 for confirmUnclear "yes" (ValidationPipe)', async () => {
      const res = await retry('post-1', { body: { confirmUnclear: 'yes' } });
      expect(res.status).toBe(400);
      expect(repository.getPostForRetry).not.toHaveBeenCalled();
      nothingStarted();
    });
  });

  describe('log', () => {
    it('holds actor and post id, never the post text', async () => {
      await retry();
      const text = logs.mock.calls.flat().join('\n');
      expect(text).toContain(`actor=${ACTOR}`);
      expect(text).toContain('post=post-1');
      expect(text).toContain('started');
      expect(text).not.toContain(CONTENT);
    });

    it('logs rejections with code, still without the post text', async () => {
      repository.getPostForRetry.mockResolvedValue(postRow({ state: 'DRAFT' }));
      await retry();
      const text = logs.mock.calls.flat().join('\n');
      expect(text).toContain('rejected code=not_failed');
      expect(text).toContain(`actor=${ACTOR}`);
      expect(text).not.toContain(CONTENT);
    });

    it('does not log the raw path for an unknown post (post=-)', async () => {
      repository.getPostForRetry.mockResolvedValue(null);
      await retry('raw-path-id');
      const text = logs.mock.calls.flat().join('\n');
      expect(text).toContain('post=-');
      expect(text).not.toContain('raw-path-id');
    });
  });
});
