import {
  demoIntegrationIds,
  INBOX_CURSOR_PATTERN,
  INBOX_FACEBOOK_POSTS_PER_PAGE,
  INBOX_MENTION_MAX_LENGTH,
  INBOX_MENTIONS_LIMIT,
  INBOX_REPLIES_LIMIT,
  INBOX_TIME_PATTERN,
  InboxOwnershipUnknownError,
  INBOX_READ_BUDGET_MS,
  INBOX_WINDOW_DAYS,
  inboxDemoEnabled,
  inboxEnabled,
  InboxPlatformError,
  inboxRoutesEnabled,
  inboxWebhookRoutesEnabled,
  InboxUsageMeter,
  inboxWindow,
  isDemoIntegration,
  isInboxCursor,
  isIntegrationId,
  isPlatformId,
  mentionNames,
  YSOCIAL_DEMO_INTEGRATIONS_ENV,
  YSOCIAL_INBOX_ENABLED_ENV,
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

describe('inboxEnabled and inboxRoutesEnabled (PR 73)', () => {
  const inbox = (value?: string) => ({ [YSOCIAL_INBOX_ENABLED_ENV]: value });

  it('switches on only with exactly "true"', () => {
    expect(inboxEnabled(inbox('true'))).toBe(true);
    for (const value of [
      undefined,
      '',
      'TRUE',
      'True',
      '1',
      'yes',
      ' true',
      'true ',
      'false',
    ]) {
      expect(inboxEnabled(inbox(value))).toBe(false);
    }
  });

  it('opens the routes with the demo list or with the switch, else not', () => {
    expect(inboxRoutesEnabled({})).toBe(false);
    expect(inboxRoutesEnabled(inbox('false'))).toBe(false);
    expect(inboxRoutesEnabled(inbox('true'))).toBe(true);
    expect(inboxRoutesEnabled(env('int-1'))).toBe(true);
    expect(inboxRoutesEnabled({ ...env('int-1'), ...inbox('true') })).toBe(
      true
    );
  });

  it('does not let the switch open the demo-only check', () => {
    expect(inboxDemoEnabled(inbox('true'))).toBe(false);
  });
});

describe('inboxWebhookRoutesEnabled (PR 74)', () => {
  it('is on with the demo list or with YSOCIAL_INBOX_EVENTS=true', () => {
    expect(inboxWebhookRoutesEnabled(env('int-demo-1'))).toBe(true);
    expect(inboxWebhookRoutesEnabled({ YSOCIAL_INBOX_EVENTS: 'true' })).toBe(
      true
    );
  });

  it('is off with YSOCIAL_INBOX_ENABLED=true alone', () => {
    expect(
      inboxWebhookRoutesEnabled({ [YSOCIAL_INBOX_ENABLED_ENV]: 'true' })
    ).toBe(false);
  });

  it.each([undefined, '', 'false', 'TRUE', '1'])(
    'is off for the switch %j without a demo list',
    (value) => {
      expect(inboxWebhookRoutesEnabled({ YSOCIAL_INBOX_EVENTS: value })).toBe(
        false
      );
      expect(
        inboxWebhookRoutesEnabled({
          ...env(' , '),
          YSOCIAL_INBOX_EVENTS: value,
        })
      ).toBe(false);
    }
  );

  it('does not switch on the other inbox routes', () => {
    expect(inboxRoutesEnabled({ YSOCIAL_INBOX_EVENTS: 'true' })).toBe(false);
  });
});

describe('isIntegrationId', () => {
  it.each(['clx1abc', 'int-demo_1', 'A', 'a'.repeat(64)])(
    'accepts %s',
    (id) => {
      expect(isIntegrationId(id)).toBe(true);
    }
  );

  it.each(['', 'a'.repeat(65), '../x', 'a/b', 'a b', 'a.b', 'a?b=1', 'ä'])(
    'rejects "%s"',
    (id) => {
      expect(isIntegrationId(id)).toBe(false);
    }
  );

  it('rejects non-strings', () => {
    expect(isIntegrationId(undefined)).toBe(false);
    expect(isIntegrationId(5)).toBe(false);
    expect(isIntegrationId(null)).toBe(false);
  });
});

describe('isInboxCursor', () => {
  it.each(['QVFIUk1', 'abc_-=', 'a'.repeat(512)])('accepts %s', (value) => {
    expect(isInboxCursor(value)).toBe(true);
  });

  it.each(['', 'a'.repeat(513), 'a/b', 'a&b=1', 'a b', 'a+b', 'a.b', '%2F'])(
    'rejects "%s"',
    (value) => {
      expect(isInboxCursor(value)).toBe(false);
    }
  );

  it('rejects non-strings', () => {
    expect(isInboxCursor(undefined)).toBe(false);
    expect(isInboxCursor(1)).toBe(false);
  });
});

describe('the read limits', () => {
  it('keeps the numbers the hub plans with', () => {
    expect(INBOX_WINDOW_DAYS).toBe(30);
    expect(INBOX_FACEBOOK_POSTS_PER_PAGE).toBe(10);
    expect(INBOX_REPLIES_LIMIT).toBe(25);
    // Below the 35 s of the hub and the 60 s of nginx.
    expect(INBOX_READ_BUDGET_MS).toBe(25_000);
  });
});

describe('inboxWindow', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');

  it('is the last 30 days of posts without a query', () => {
    expect(inboxWindow({}, now)).toEqual({
      since: null,
      postsFrom: new Date('2026-10-18T12:00:00.000Z'),
      postsBefore: null,
      cursor: null,
    });
  });

  it('takes since as it is and keeps the window of 30 days', () => {
    const window = inboxWindow({ since: '2026-11-16T08:30:00.000Z' }, now);
    expect(window.since).toEqual(new Date('2026-11-16T08:30:00.000Z'));
    expect(window.postsFrom).toEqual(new Date('2026-10-18T12:00:00.000Z'));
    expect(window.postsBefore).toBeNull();
  });

  it('turns olderThan into the posts before it, without the lower bound', () => {
    const window = inboxWindow({ olderThan: '2026-10-01T00:00:00.000Z' }, now);
    expect(window.postsFrom).toBeNull();
    expect(window.postsBefore).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('with olderThan takes postsAfter as the lower bound', () => {
    const window = inboxWindow(
      {
        olderThan: '2026-10-01T00:00:00.000Z',
        postsAfter: '2026-09-01T00:00:00.000Z',
      },
      now
    );
    expect(window.postsFrom).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(window.postsBefore).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('ignores postsAfter without olderThan: the window of 30 days stays', () => {
    const window = inboxWindow({ postsAfter: '2026-09-01T00:00:00.000Z' }, now);
    expect(window.postsFrom).toEqual(new Date('2026-10-18T12:00:00.000Z'));
    expect(window.postsBefore).toBeNull();
  });

  it('has no lower bound for an unreadable postsAfter', () => {
    const window = inboxWindow(
      { olderThan: '2026-10-01T00:00:00.000Z', postsAfter: 'x' },
      now
    );
    expect(window.postsFrom).toBeNull();
  });

  it('passes a valid cursor on and drops an invalid one', () => {
    expect(inboxWindow({ cursor: 'QVFIUk1' }, now).cursor).toBe('QVFIUk1');
    expect(inboxWindow({ cursor: 'a/b' }, now).cursor).toBeNull();
    expect(inboxWindow({ cursor: 'a&b' }, now).cursor).toBeNull();
  });

  it('ignores a date that cannot be read', () => {
    const window = inboxWindow({ since: 'gestern', olderThan: 'x' }, now);
    expect(window.since).toBeNull();
    expect(window.postsBefore).toBeNull();
    expect(window.postsFrom).toEqual(new Date('2026-10-18T12:00:00.000Z'));
  });
});

describe('InboxUsageMeter', () => {
  const header = (value: unknown) => JSON.stringify(value);
  const meter = (value?: string | null) => {
    const m = new InboxUsageMeter();
    m.record(value);
    return m;
  };

  it('is null without a header', () => {
    expect(new InboxUsageMeter().usage).toBeNull();
    expect(meter(undefined).usage).toBeNull();
    expect(meter(null).usage).toBeNull();
    expect(meter('').usage).toBeNull();
  });

  it('takes the highest of call_count, total_cputime and total_time', () => {
    const m = meter(
      header({
        '10000000000001': [
          {
            type: 'pages',
            call_count: 12,
            total_cputime: 40,
            total_time: 7,
            estimated_time_to_regain_access: 0,
          },
        ],
      })
    );
    expect(m.usage).toEqual({ percent: 40, regainMinutes: 0 });
  });

  it('takes the largest estimated_time_to_regain_access', () => {
    const m = meter(
      header({
        '1': [
          { call_count: 90, estimated_time_to_regain_access: 5 },
          { call_count: 10, estimated_time_to_regain_access: 17 },
        ],
      })
    );
    expect(m.usage).toEqual({ percent: 90, regainMinutes: 17 });
  });

  it('keeps the maximum over several answers, never lowers it', () => {
    const m = new InboxUsageMeter();
    m.record(header({ '1': [{ call_count: 30 }] }));
    m.record(header({ '1': [{ call_count: 55 }] }));
    m.record(header({ '1': [{ call_count: 20 }] }));
    m.record(undefined);
    expect(m.usage).toEqual({ percent: 55, regainMinutes: 0 });
  });

  it('does not carry the business id', () => {
    const m = meter(header({ '10000000000001': [{ call_count: 3 }] }));
    expect(JSON.stringify(m.usage)).not.toContain('10000000000001');
  });

  it.each([
    ['broken JSON', '{"1": [{"call_count": 3'],
    ['an array', '[{"call_count": 3}]'],
    ['a bare number', '5'],
    ['null', 'null'],
    ['a string', '"x"'],
  ])('ignores %s', (_name, value) => {
    expect(meter(value).usage).toBeNull();
  });

  it('ignores a header longer than 10000 characters', () => {
    const long = header({
      '1': [{ call_count: 99, padding: 'x'.repeat(10_000) }],
    });
    expect(long.length).toBeGreaterThan(10_000);
    expect(meter(long).usage).toBeNull();
  });

  it('ignores negative, non-numeric and infinite values', () => {
    const m = meter(
      header({
        '1': [
          {
            call_count: -50,
            total_cputime: '80',
            total_time: null,
            estimated_time_to_regain_access: -3,
          },
        ],
      })
    );
    expect(m.usage).toEqual({ percent: 0, regainMinutes: 0 });
  });

  it('does not break on entries that are not objects', () => {
    const m = meter(header({ '1': [null, 'x', 5, { call_count: 8 }], '2': 4 }));
    expect(m.usage).toEqual({ percent: 8, regainMinutes: 0 });
  });
});

describe('INBOX_TIME_PATTERN and INBOX_CURSOR_PATTERN', () => {
  it.each([
    '2026-11-17T12:00:00Z',
    '2026-11-17T12:00',
    '2026-11-17T12:00:00.000+01:00',
  ])('INBOX_TIME_PATTERN accepts %s', (value) => {
    expect(INBOX_TIME_PATTERN.test(value)).toBe(true);
  });

  it.each(['2026-11-17', '2026-W47', '20261117', '2026-322', 'gestern', ''])(
    'INBOX_TIME_PATTERN rejects "%s"',
    (value) => {
      expect(INBOX_TIME_PATTERN.test(value)).toBe(false);
    }
  );

  it('INBOX_CURSOR_PATTERN is the pattern of isInboxCursor', () => {
    expect(INBOX_CURSOR_PATTERN.test('abc_-=')).toBe(true);
    expect(INBOX_CURSOR_PATTERN.test('a/b')).toBe(false);
    expect(INBOX_CURSOR_PATTERN.test('a&b')).toBe(false);
    expect(INBOX_CURSOR_PATTERN.test('a'.repeat(513))).toBe(false);
  });
});

describe('InboxOwnershipUnknownError', () => {
  it('is an Error with a fixed message and no details', () => {
    const err = new InboxOwnershipUnknownError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InboxPlatformError);
    expect(err.name).toBe('InboxOwnershipUnknownError');
    expect(err.message).toBe('ownership unknown');
  });
});

describe('mentionNames (W76)', () => {
  it('keeps only strings, no null, number, object, array or boolean', () => {
    expect(
      mentionNames([
        null,
        undefined,
        7,
        {},
        { name: 'Erika Beispiel' },
        [],
        true,
        'Max Muster',
      ])
    ).toEqual(['Max Muster']);
  });

  it('drops empty names and names of whitespace only', () => {
    expect(mentionNames(['', ' ', '\t\n', 'Erika Beispiel'])).toEqual([
      'Erika Beispiel',
    ]);
  });

  it('trims', () => {
    expect(mentionNames(['  Erika Beispiel \n'])).toEqual(['Erika Beispiel']);
  });

  it('cuts a name of 301 characters to 300', () => {
    expect(INBOX_MENTION_MAX_LENGTH).toBe(300);
    const [name] = mentionNames(['a'.repeat(301)]);
    expect(name).toBe('a'.repeat(300));
  });

  it('keeps a name of exactly 300 characters', () => {
    expect(mentionNames(['a'.repeat(300)])).toEqual(['a'.repeat(300)]);
  });

  it('leaves no single high surrogate at the end of a cut name', () => {
    const [name] = mentionNames(['a'.repeat(299) + '😀x']);
    expect(name).toBe('a'.repeat(299));
    expect(name).toHaveLength(299);
    expect(name.charCodeAt(name.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });

  it('drops doubles, also those that are equal only after trim or cut', () => {
    expect(
      mentionNames([
        'Erika Beispiel',
        ' Erika Beispiel ',
        'Max Muster',
        'Erika Beispiel',
      ])
    ).toEqual(['Erika Beispiel', 'Max Muster']);
    expect(
      mentionNames(['a'.repeat(300), 'a'.repeat(301), 'a'.repeat(350)])
    ).toEqual(['a'.repeat(300)]);
  });

  it('keeps the order of the input', () => {
    expect(mentionNames(['Zora', 'Anna', 'Max', 'Anna'])).toEqual([
      'Zora',
      'Anna',
      'Max',
    ]);
  });

  it('gives at most 50 of 60 names, the first ones', () => {
    expect(INBOX_MENTIONS_LIMIT).toBe(50);
    const names = Array.from({ length: 60 }, (_, i) => `Name ${i}`);
    const out = mentionNames(names);
    expect(out).toHaveLength(50);
    expect(out).toEqual(names.slice(0, 50));
  });

  it('gives [] for no names', () => {
    expect(mentionNames([])).toEqual([]);
  });
});
