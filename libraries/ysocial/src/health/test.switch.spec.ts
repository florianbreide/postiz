import {
  invalidTokenSwitchActive,
  invalidTokenSwitchKey,
  isTestIntegration,
  testIntegrationIds,
  testRoutesEnabled,
} from './test.switch';

describe('testRoutesEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(testRoutesEnabled({ YSOCIAL_TEST_ROUTES: 'true' })).toBe(true);
    for (const value of [
      'TRUE',
      'True',
      '1',
      'yes',
      ' true',
      'true ',
      '',
      undefined,
    ]) {
      expect(testRoutesEnabled({ YSOCIAL_TEST_ROUTES: value })).toBe(false);
    }
    expect(testRoutesEnabled({})).toBe(false);
  });
});

describe('testIntegrationIds', () => {
  it('trims and ignores empty entries', () => {
    expect(
      testIntegrationIds({ YSOCIAL_TEST_INTEGRATIONS: ' int-1 ,, int-2,  ,' })
    ).toEqual(['int-1', 'int-2']);
  });

  it('is empty when unset or blank', () => {
    expect(testIntegrationIds({})).toEqual([]);
    expect(testIntegrationIds({ YSOCIAL_TEST_INTEGRATIONS: '  ' })).toEqual([]);
  });
});

describe('isTestIntegration', () => {
  const env = {
    YSOCIAL_TEST_ROUTES: 'true',
    YSOCIAL_TEST_INTEGRATIONS: 'int-1, int-2',
  };

  it('is true for a listed channel with test routes on', () => {
    expect(isTestIntegration(env, 'int-1')).toBe(true);
    expect(isTestIntegration(env, 'int-2')).toBe(true);
  });

  it('is false for a channel that is not listed (also a prefix)', () => {
    expect(isTestIntegration(env, 'int-3')).toBe(false);
    expect(isTestIntegration(env, 'int')).toBe(false);
    expect(isTestIntegration(env, '')).toBe(false);
  });

  it('is false when test routes are off, whatever is listed', () => {
    expect(
      isTestIntegration({ ...env, YSOCIAL_TEST_ROUTES: 'false' }, 'int-1')
    ).toBe(false);
    expect(
      isTestIntegration({ YSOCIAL_TEST_INTEGRATIONS: 'int-1' }, 'int-1')
    ).toBe(false);
  });
});

describe('invalidTokenSwitchKey', () => {
  it('has the documented form', () => {
    expect(invalidTokenSwitchKey('int-1')).toBe(
      'ysocial:test:invalid-token:int-1'
    );
  });
});

describe('invalidTokenSwitchActive', () => {
  const now = Date.parse('2026-10-27T06:00:00.000Z');
  const until = (iso: string) => JSON.stringify({ until: iso });

  it('is true while "until" is in the future', () => {
    expect(
      invalidTokenSwitchActive(until('2026-10-27T06:00:00.001Z'), now)
    ).toBe(true);
    expect(
      invalidTokenSwitchActive(until('2026-10-27T06:30:00.000Z'), now)
    ).toBe(true);
  });

  it('is false for an "until" further ahead than the TTL', () => {
    expect(
      invalidTokenSwitchActive(until('2026-10-27T06:30:00.001Z'), now)
    ).toBe(false);
    expect(
      invalidTokenSwitchActive(until('9999-12-31T00:00:00.000Z'), now)
    ).toBe(false);
  });

  it('is false when "until" is over or exactly now', () => {
    expect(
      invalidTokenSwitchActive(until('2026-10-27T06:00:00.000Z'), now)
    ).toBe(false);
    expect(
      invalidTokenSwitchActive(until('2026-10-27T05:59:59.999Z'), now)
    ).toBe(false);
  });

  it('is false without a usable "until"', () => {
    expect(
      invalidTokenSwitchActive('{"since":"2026-10-27T05:50:00Z"}', now)
    ).toBe(false);
    expect(invalidTokenSwitchActive(until('not a date'), now)).toBe(false);
    expect(invalidTokenSwitchActive('{}', now)).toBe(false);
  });

  it.each([
    ['no JSON', 'switch on'],
    ['"1"', '1'],
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['JSON null', 'null'],
  ])('is false for %s', (_n, raw) => {
    expect(invalidTokenSwitchActive(raw, now)).toBe(false);
  });
});
