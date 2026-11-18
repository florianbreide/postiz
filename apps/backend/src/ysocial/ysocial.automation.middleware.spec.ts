// The real PostsService pulls in half of Postiz, some of it ESM-only.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} })
);

// The real IntegrationManager loads every provider, some of them ESM-only.
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class IntegrationManager {},
}));

import {
  Body,
  Controller,
  Global,
  INestApplication,
  Logger,
  Module,
  Post,
  Put,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { TemporalService } from 'nestjs-temporal-core';
import { YsocialModule } from './ysocial.module';
import { YsocialReadRepository } from '../../../../libraries/ysocial/src/database/ysocial.read.repository';
import { YsocialRetryRepository } from '../../../../libraries/ysocial/src/database/ysocial.retry.repository';
import { YsocialTokenKeyCheck } from '../../../../libraries/ysocial/src/tokens/ysocial.token.key.check';
import { YsocialInboxRepository } from '../../../../libraries/ysocial/src/database/ysocial.inbox.repository';
import { YsocialWebhookRepository } from '../../../../libraries/ysocial/src/database/ysocial.webhook.repository';
import { YsocialAutomationRepository } from '../../../../libraries/ysocial/src/database/ysocial.automation.repository';
import { YsocialAutomationCheck } from '../../../../libraries/ysocial/src/automation/ysocial.automation.check';
import {
  AUTOMATION_BLOCKED_CODE,
  AUTOMATION_BLOCKED_MESSAGE,
} from '../../../../libraries/ysocial/src/automation/automation.rules';

const reached = jest.fn();
const handle = (name: string) => {
  reached(name);
  return { ok: true };
};

// Stand-ins with exactly the routes of Postiz (the upstream spec reads them
// from the Postiz sources). They only record that they were reached.
@Controller('posts')
class FakePostsController {
  @Post()
  create(@Body() _body: unknown) {
    return handle('posts.create');
  }
  @Post(':id/comments')
  comment(@Body() _body: unknown) {
    return handle('posts.comments');
  }
  @Put(':id/date')
  date(@Body() _body: unknown) {
    return handle('posts.date');
  }
}

@Controller('public/v1')
class FakePublicController {
  @Post('posts')
  create(@Body() _body: unknown) {
    return handle('public.create');
  }
  @Put('posts/:id/settings')
  settings(@Body() _body: unknown) {
    return handle('public.settings');
  }
}

@Controller('integrations')
class FakeIntegrationsController {
  @Post(':id/plugs')
  plug(@Body() _body: unknown) {
    return handle('integrations.plug');
  }
  @Put('plugs/:id/activate')
  activate(@Body() _body: unknown) {
    return handle('integrations.activate');
  }
}

@Global()
@Module({
  controllers: [
    FakePostsController,
    FakePublicController,
    FakeIntegrationsController,
  ],
  providers: [
    { provide: PostsService, useValue: {} },
    { provide: IntegrationManager, useValue: {} },
    { provide: TemporalService, useValue: {} },
  ],
  exports: [PostsService, IntegrationManager, TemporalService],
})
class PostizRoutesTestModule {}

const SECRET = 'Erfundener Posttext, der nie im Log stehen darf';
const plugSettings = { 'plug--like--integrations': ['channel-1'] };

describe('YsocialAutomationMiddleware (D15, rule 2)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let logs: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PostizRoutesTestModule, YsocialModule],
    })
      .overrideProvider(YsocialReadRepository)
      .useValue({})
      .overrideProvider(YsocialRetryRepository)
      .useValue({})
      .overrideProvider(YsocialTokenKeyCheck)
      .useValue({})
      .overrideProvider(YsocialInboxRepository)
      .useValue({})
      .overrideProvider(YsocialWebhookRepository)
      .useValue({})
      .overrideProvider(YsocialAutomationRepository)
      .useValue({})
      .overrideProvider(YsocialAutomationCheck)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    reached.mockClear();
    logs = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => logs.mockRestore());

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  const expectBlocked = async (res: Response) => {
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe(AUTOMATION_BLOCKED_CODE);
    expect(json.code).toBe('automation_blocked');
    expect(json.message).toBe(AUTOMATION_BLOCKED_MESSAGE);
    expect(reached).not.toHaveBeenCalled();
  };

  const expectAllowed = async (res: Response, name: string) => {
    expect(res.status).toBe(201 - (res.status === 200 ? 1 : 0));
    expect(await res.json()).toEqual({ ok: true });
    expect(reached).toHaveBeenCalledWith(name);
  };

  describe.each([
    ['POST /posts', '/posts', 'posts.create'],
    ['POST /public/v1/posts', '/public/v1/posts', 'public.create'],
  ])('%s', (_name, path, handler) => {
    it('blocks a repeat interval', async () => {
      await expectBlocked(
        await send('POST', path, { inter: 7, posts: [{ settings: {} }] })
      );
    });

    it('blocks a repeat interval sent as a string', async () => {
      await expectBlocked(await send('POST', path, { inter: '7', posts: [] }));
    });

    it('blocks an internal plug in one of several posts', async () => {
      await expectBlocked(
        await send('POST', path, {
          posts: [{ settings: {} }, { settings: plugSettings }],
        })
      );
    });

    it('allows a normal save', async () => {
      await expectAllowed(
        await send('POST', path, {
          type: 'schedule',
          inter: 0,
          posts: [{ settings: { __type: 'x' } }],
        }),
        handler
      );
    });

    it('allows a save without inter and with an empty plug list', async () => {
      await expectAllowed(
        await send('POST', path, {
          posts: [{ settings: { 'plug--like--integrations': [] } }],
        }),
        handler
      );
    });

    it('blocks with a query string and a trailing slash', async () => {
      await expectBlocked(
        await send('POST', `${path}/?x=1`, { inter: 2, posts: [] })
      );
    });
  });

  describe('global plugs', () => {
    it('blocks creating one, whatever the body', async () => {
      await expectBlocked(
        await send('POST', '/integrations/channel-1/plugs', {
          func: 'autoRepostPost',
          fields: [],
        })
      );
      reached.mockClear();
      await expectBlocked(await send('POST', '/integrations/channel-1/plugs'));
    });

    it.each([true, 'true', 1, '1', 'false'])(
      'blocks switching one on with status %p (Postiz stores !!status)',
      async (status) => {
        await expectBlocked(
          await send('PUT', '/integrations/plugs/p1/activate', { status })
        );
      }
    );

    it.each([false, 0, '', null, 'MISSING'])(
      'allows status %p',
      async (status) => {
        const body = status === 'MISSING' ? {} : { status };
        const res = await send('PUT', '/integrations/plugs/p1/activate', body);
        expect(res.status).toBe(200);
        expect(reached).toHaveBeenCalledWith('integrations.activate');
      }
    );

    it('matches the paths without regard to case', async () => {
      await expectBlocked(
        await send('PUT', '/integrations/plugs/p1/ACTIVATE', { status: true })
      );
      await expectBlocked(
        await send('POST', '/integrations/channel-1/PLUGS', {})
      );
    });
  });

  describe('PUT /public/v1/posts/:id/settings', () => {
    it('blocks an internal plug in body.settings', async () => {
      await expectBlocked(
        await send('PUT', '/public/v1/posts/p1/settings', {
          settings: plugSettings,
        })
      );
    });

    it('allows settings without a plug', async () => {
      for (const settings of [
        {},
        { title: 'x' },
        { 'plug--like--integrations': [] },
      ]) {
        reached.mockClear();
        const res = await send('PUT', '/public/v1/posts/p1/settings', {
          settings,
        });
        expect(res.status).toBe(200);
        expect(reached).toHaveBeenCalledWith('public.settings');
      }
    });

    it('allows a body without settings', async () => {
      const res = await send('PUT', '/public/v1/posts/p1/settings', {});
      expect(res.status).toBe(200);
    });
  });

  describe('other routes', () => {
    it('does not look at POST /posts/:id/comments', async () => {
      const res = await send('POST', '/posts/p1/comments', {
        inter: 9,
        posts: [{ settings: plugSettings }],
      });
      expect(res.status).toBe(201);
      expect(reached).toHaveBeenCalledWith('posts.comments');
    });

    it('does not look at PUT /posts/:id/date', async () => {
      const res = await send('PUT', '/posts/p1/date', {
        inter: 9,
        date: '2026-01-01T00:00:00Z',
      });
      expect(res.status).toBe(200);
      expect(reached).toHaveBeenCalledWith('posts.date');
    });
  });

  describe('log', () => {
    it('names method and kind, never the body', async () => {
      await send('POST', '/posts', {
        inter: 5,
        posts: [{ settings: plugSettings, value: [{ content: SECRET }] }],
      });
      await send('POST', '/posts', {
        posts: [{ settings: plugSettings, value: [{ content: SECRET }] }],
      });
      await send('POST', '/integrations/c1/plugs', { fields: [SECRET] });
      const lines = logs.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([
        'automation blocked method=POST reason=repeat',
        'automation blocked method=POST reason=plug',
        'automation blocked method=POST reason=global-plug',
      ]);
      expect(lines.join('\n')).not.toContain(SECRET);
      expect(lines.join('\n')).not.toContain('channel-1');
    });
  });
});
