import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import {
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { YsocialTokenGuard } from './ysocial.token.guard';
import { YsocialModule } from './ysocial.module';
import { YsocialStatusController } from './ysocial.status.controller';
import { YSOCIAL_MODULE_VERSION } from '../../../../libraries/ysocial/src/ysocial.version';

const ENV = 'YSOCIAL_SERVICE_TOKEN';
const token = randomBytes(32).toString('hex');
const wrongToken = randomBytes(32).toString('hex');

const contextWith = (authorization?: string) => {
  const setHeader = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authorization ? { authorization } : {},
      }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
};

describe('YsocialTokenGuard', () => {
  const original = process.env[ENV];
  const guard = new YsocialTokenGuard();

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = original;
    }
  });

  it('answers 503 when the token is not configured', () => {
    delete process.env[ENV];
    const { context } = contextWith(`Bearer ${token}`);
    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException
    );
  });

  it('answers 503 when the configured token is too short', () => {
    process.env[ENV] = 'too-short';
    const { context } = contextWith('Bearer too-short');
    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException
    );
  });

  it('answers 401 without an Authorization header', () => {
    process.env[ENV] = token;
    const { context, setHeader } = contextWith();
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="ysocial"'
    );
  });

  it('answers 401 with a wrong token', () => {
    process.env[ENV] = token;
    const { context } = contextWith(`Bearer ${wrongToken}`);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('lets the right token through', () => {
    process.env[ENV] = token;
    const { context } = contextWith(`Bearer ${token}`);
    expect(guard.canActivate(context)).toBe(true);
  });
});

// Postiz's global guards and middleware let a new controller through, so a
// ysocial controller without its own guard would be public. This test finds
// every controller class in apps/backend/src/ysocial (any file, any module)
// and fails if one is not protected at class level. A stricter guard is
// allowed: add it to ACCEPTED_GUARDS.
describe('every ysocial controller', () => {
  type Constructor = new (...args: any[]) => unknown;
  const ACCEPTED_GUARDS: Constructor[] = [YsocialTokenGuard];

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
    });

  const controllers = sourceFiles(__dirname).flatMap((file) =>
    Object.values(require(file) as Record<string, unknown>).filter(
      (value): value is Constructor =>
        typeof value === 'function' &&
        Reflect.getMetadata(CONTROLLER_WATERMARK, value) === true
    )
  );

  const isAcceptedGuard = (guard: unknown) =>
    ACCEPTED_GUARDS.some(
      (accepted) => guard === accepted || guard instanceof accepted
    );

  it('finds the controllers', () => {
    expect(controllers).toContain(YsocialStatusController);
  });

  it.each(
    controllers.map((controller) => ({ name: controller.name, controller }))
  )('$name is protected by YsocialTokenGuard', ({ controller }) => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
    expect(guards.some(isAcceptedGuard)).toBe(true);
  });
});

describe('GET /ysocial/status', () => {
  const original = process.env[ENV];
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [YsocialModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
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

  const get = (authorization?: string) =>
    fetch(`${baseUrl}/ysocial/status`, {
      headers: authorization ? { authorization } : {},
    });

  it('returns 503 without a configured token', async () => {
    delete process.env[ENV];
    const res = await get(`Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it('returns 401 without or with a wrong token', async () => {
    process.env[ENV] = token;
    expect((await get()).status).toBe(401);
    const wrong = await get(`Bearer ${wrongToken}`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe(
      'Bearer realm="ysocial"'
    );
  });

  it('returns 200 and the module status with the right token', async () => {
    process.env[ENV] = token;
    const res = await get(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      module: 'ysocial',
      version: YSOCIAL_MODULE_VERSION,
    });
  });
});
