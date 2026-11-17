import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { YsocialInboxEventsGuard } from './ysocial.inbox.events.guard';

const ENV = 'YSOCIAL_INBOX_EVENTS';

const contextFor = (method = 'GET', originalUrl = '/ysocial-meta-webhook') =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl }) }),
  } as unknown as ExecutionContext);

describe('YsocialInboxEventsGuard', () => {
  const original = process.env[ENV];
  const originalList = process.env.YSOCIAL_DEMO_INTEGRATIONS;
  const guard = new YsocialInboxEventsGuard();

  afterEach(() => {
    for (const [name, value] of [
      [ENV, original],
      ['YSOCIAL_DEMO_INTEGRATIONS', originalList],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('lets the request through with YSOCIAL_INBOX_EVENTS=true', () => {
    process.env[ENV] = 'true';
    expect(guard.canActivate(contextFor())).toBe(true);
  });

  it.each([undefined, '', 'false', 'TRUE', 'True', '1', ' true', 'yes'])(
    'answers 404 with YSOCIAL_INBOX_EVENTS=%j',
    (value) => {
      if (value === undefined) {
        delete process.env[ENV];
      } else {
        process.env[ENV] = value;
      }
      expect(() => guard.canActivate(contextFor())).toThrow(NotFoundException);
    }
  );

  it('answers 404 also with a demo list: the receiver is not tied to it any more', () => {
    delete process.env[ENV];
    process.env.YSOCIAL_DEMO_INTEGRATIONS = 'int-demo-1';
    expect(() => guard.canActivate(contextFor('POST'))).toThrow(
      NotFoundException
    );
  });

  it('answers with the text of the not-found handler of Nest', () => {
    delete process.env[ENV];
    try {
      guard.canActivate(contextFor('POST', '/ysocial-meta-webhook?x=1'));
      fail('should have thrown');
    } catch (err) {
      expect((err as NotFoundException).getStatus()).toBe(404);
      expect((err as NotFoundException).message).toBe(
        'Cannot POST /ysocial-meta-webhook?x=1'
      );
    }
  });
});
