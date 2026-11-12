import {
  demoIntegrationIds,
  inboxDemoEnabled,
  InboxPlatformError,
  isDemoIntegration,
  isPlatformId,
  YSOCIAL_DEMO_INTEGRATIONS_ENV,
} from './inbox.rules';

const env = (value?: string) => ({ [YSOCIAL_DEMO_INTEGRATIONS_ENV]: value });

describe('demoIntegrationIds', () => {
  it('trims the entries and drops empty ones', () => {
    expect(demoIntegrationIds(env(' int-demo-1 , ,int-demo-2,,'))).toEqual([
      'int-demo-1',
      'int-demo-2',
    ]);
  });

  it('is empty without the variable, empty or with commas only', () => {
    expect(demoIntegrationIds({})).toEqual([]);
    expect(demoIntegrationIds(env(''))).toEqual([]);
    expect(demoIntegrationIds(env(' , ,, '))).toEqual([]);
  });
});

describe('inboxDemoEnabled', () => {
  it('is true only with at least one listed channel', () => {
    expect(inboxDemoEnabled(env('int-demo-1'))).toBe(true);
    expect(inboxDemoEnabled(env(''))).toBe(false);
    expect(inboxDemoEnabled(env(',,'))).toBe(false);
    expect(inboxDemoEnabled({})).toBe(false);
  });
});

describe('isDemoIntegration', () => {
  it('matches a listed id exactly', () => {
    expect(isDemoIntegration(env('int-demo-1,int-demo-2'), 'int-demo-2')).toBe(
      true
    );
  });

  it('does not match a prefix or a longer id', () => {
    expect(isDemoIntegration(env('int-demo-12'), 'int-demo-1')).toBe(false);
    expect(isDemoIntegration(env('int-demo-1'), 'int-demo-12')).toBe(false);
    expect(isDemoIntegration(env('int-demo-1'), 'INT-DEMO-1')).toBe(false);
  });

  it('does not match an empty id, also not with empty list entries', () => {
    expect(isDemoIntegration(env('int-demo-1,,'), '')).toBe(false);
    expect(isDemoIntegration(env(''), '')).toBe(false);
    expect(isDemoIntegration({}, 'int-demo-1')).toBe(false);
  });
});

describe('isPlatformId', () => {
  it.each([
    '17950000000000001',
    '17840000000000001_17900000000000001',
    '_',
    '0',
  ])('accepts %s', (value) => {
    expect(isPlatformId(value)).toBe(true);
  });

  it.each(['../me', '1/2', '1.2', '1?x=2', '1 2', 'abc', '', '1'.repeat(65)])(
    'rejects %p',
    (value) => {
      expect(isPlatformId(value)).toBe(false);
    }
  );

  it('accepts 64 characters and rejects non-strings', () => {
    expect(isPlatformId('1'.repeat(64))).toBe(true);
    for (const value of [undefined, null, 123, {}, ['1'], true]) {
      expect(isPlatformId(value)).toBe(false);
    }
  });
});

describe('InboxPlatformError', () => {
  it('carries codes only in the message, never the reason', () => {
    const error = new InboxPlatformError({
      unavailable: false,
      status: 400,
      code: 100,
      subcode: 33,
      reason: 'Erfundene Meldung von Meta mit einem Kommentartext',
    });
    expect(error.message).toBe('platform error status=400 code=100/33');
    expect(error.message).not.toContain('Erfundene');
    expect(error.details.reason).toContain('Erfundene');
    expect(error.name).toBe('InboxPlatformError');
    expect(error).toBeInstanceOf(Error);
  });

  it('uses - for missing codes', () => {
    expect(new InboxPlatformError({ unavailable: false }).message).toBe(
      'platform error status=- code=-/-'
    );
  });

  it('says only "platform unavailable" when the platform was not reached', () => {
    const error = new InboxPlatformError({
      unavailable: true,
      reason: 'darf nicht in die Meldung',
    });
    expect(error.message).toBe('platform unavailable');
  });
});
