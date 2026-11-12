import {
  applyProblemChanges,
  berlinDay,
  channelFlag,
  ChannelProblemChanges,
  ChannelRow,
  diffChannels,
  problemChanges,
  tokenExpiringEvent,
  tokenExpiry,
} from './channel.health';

// Invented channels of an invented organization.
const NOW = Date.parse('2026-10-27T06:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const channel = (patch: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 'int-1',
  organizationId: 'org-1',
  customerId: 'customer-1',
  name: 'Y Social Test',
  providerIdentifier: 'facebook',
  disabled: false,
  refreshNeeded: false,
  inBetweenSteps: false,
  tokenExpiration: new Date(NOW + 30 * DAY),
  updatedAt: new Date(NOW - DAY),
  ...patch,
});

describe('channel flags and token expiry', () => {
  it('reads the database fields', () => {
    expect(channelFlag(channel())).toBeUndefined();
    expect(channelFlag(channel({ refreshNeeded: true }))).toBe(
      'refresh_needed'
    );
    expect(channelFlag(channel({ inBetweenSteps: true }))).toBe(
      'in_between_steps'
    );
    expect(channelFlag(channel({ disabled: true }))).toBe('disabled');
  });

  it('warns 7 days before the token expires', () => {
    expect(tokenExpiry(channel(), NOW)).toBeUndefined();
    expect(
      tokenExpiry(channel({ tokenExpiration: null }), NOW)
    ).toBeUndefined();
    expect(
      tokenExpiry(channel({ tokenExpiration: new Date(NOW + 7 * DAY) }), NOW)
    ).toEqual({
      expiresAt: new Date(NOW + 7 * DAY).toISOString(),
      expired: false,
    });
    expect(
      tokenExpiry(channel({ tokenExpiration: new Date(NOW - 1000) }), NOW)
        ?.expired
    ).toBe(true);
  });

  it('builds the expiry event with a fixed id', () => {
    const expires = new Date(NOW + 3 * DAY);
    const event = tokenExpiringEvent(
      channel({ tokenExpiration: expires }),
      NOW
    )!;
    expect(event).toMatchObject({
      id: `channel.token_expiring:int-1:${expires.getTime()}`,
      kind: 'channel.token_expiring',
      subject: { type: 'channel', id: 'int-1' },
      postiz: {
        integrationId: 'int-1',
        organizationId: 'org-1',
        customerId: 'customer-1',
        providerIdentifier: 'facebook',
      },
      data: { expiresAt: expires.toISOString(), expired: false },
    });
  });
});

describe('diffChannels', () => {
  it('reports a disconnected channel once', () => {
    const row = channel({ refreshNeeded: true });
    const first = diffChannels({ previous: {}, channels: [row], now: NOW });
    expect(first.events.map((e) => e.kind)).toEqual(['channel.disconnected']);
    expect(first.events[0].id).toBe(
      `channel.disconnected:int-1:refresh_needed-${NOW - DAY}`
    );
    expect(first.events[0].data).toEqual({ flag: 'refresh_needed' });
    expect(first.next['int-1'].kind).toBe('channel.disconnected');

    const second = diffChannels({
      previous: first.next,
      channels: [row],
      now: NOW + 3600_000,
    });
    expect(second.events).toEqual([]);
    expect(second.next).toEqual(first.next);
  });

  it('gives the same id again after a lost state', () => {
    const row = channel({ disabled: true });
    const a = diffChannels({ previous: {}, channels: [row], now: NOW });
    const b = diffChannels({
      previous: {},
      channels: [row],
      now: NOW + 3600_000,
    });
    expect(b.events[0].id).toBe(a.events[0].id);
  });

  it('reports a reconnected channel and forgets it', () => {
    const before = diffChannels({
      previous: {},
      channels: [channel({ refreshNeeded: true })],
      now: NOW,
    });
    const after = diffChannels({
      previous: before.next,
      channels: [channel({ updatedAt: new Date(NOW + 1000) })],
      now: NOW + 3600_000,
    });
    expect(after.events.map((e) => e.kind)).toEqual(['channel.reconnected']);
    expect(after.events[0].data).toEqual({ previous: 'channel.disconnected' });
    expect(after.next).toEqual({});
  });

  it('keeps "Zugang ungültig" until the token changes', () => {
    const daily = diffChannels({
      previous: {},
      channels: [channel()],
      now: NOW,
      authInvalid: { 'int-1': 'Meta meldet: Error validating access token' },
    });
    expect(daily.events.map((e) => e.kind)).toEqual(['channel.auth_invalid']);
    expect(daily.events[0].reason).toContain('Zugang ungültig');

    const hourly = diffChannels({
      previous: daily.next,
      channels: [channel()],
      now: NOW + 3600_000,
    });
    expect(hourly.events).toEqual([]);
    expect(hourly.next['int-1'].kind).toBe('channel.auth_invalid');
    expect(hourly.next['int-1'].since).toBe(daily.next['int-1'].since);

    const reconnected = diffChannels({
      previous: hourly.next,
      channels: [
        channel({
          updatedAt: new Date(NOW + 2 * 3600_000),
          tokenExpiration: new Date(NOW + 60 * DAY),
        }),
      ],
      now: NOW + 3 * 3600_000,
    });
    expect(reconnected.events.map((e) => e.kind)).toEqual([
      'channel.reconnected',
    ]);
    expect(reconnected.next).toEqual({});
  });

  it('closes "Zugang ungültig" when the next daily check passes', () => {
    const daily = diffChannels({
      previous: {},
      channels: [channel()],
      now: NOW,
      authInvalid: { 'int-1': 'x' },
    });
    const next = diffChannels({
      previous: daily.next,
      channels: [channel()],
      now: NOW + DAY,
      authOk: ['int-1'],
    });
    expect(next.events.map((e) => e.kind)).toEqual(['channel.reconnected']);
  });

  describe('ids of "Zugang ungültig"', () => {
    const UPDATED = NOW - DAY;
    const TOKEN_EXP = NOW + 30 * DAY;
    const invalid = (
      previous: Parameters<typeof diffChannels>[0]['previous'],
      now: number
    ) =>
      diffChannels({
        previous,
        channels: [channel()],
        now,
        authInvalid: { 'int-1': 'x' },
      });
    const ok = (
      previous: Parameters<typeof diffChannels>[0]['previous'],
      now: number
    ) =>
      diffChannels({
        previous,
        channels: [channel()],
        now,
        authOk: ['int-1'],
      });

    it('carries updatedAt and the run that first saw the problem', () => {
      const first = invalid({}, NOW);
      expect(first.events[0].id).toBe(
        `channel.auth_invalid:int-1:${UPDATED}-${NOW}`
      );
      expect(first.next['int-1']).toEqual({
        kind: 'channel.auth_invalid',
        updatedAt: UPDATED,
        since: new Date(NOW).toISOString(),
        tokenExpiration: TOKEN_EXP,
      });
    });

    it('says nothing on the next daily run while the problem lasts', () => {
      const first = invalid({}, NOW);
      const second = invalid(first.next, NOW + DAY);
      expect(second.events).toEqual([]);
      expect(second.next['int-1'].since).toBe(first.next['int-1'].since);
      expect(second.next).toEqual(first.next);
    });

    it('gives a new problem after a reconnect a new id', () => {
      const first = invalid({}, NOW);
      const closed = ok(first.next, NOW + DAY);
      expect(closed.next).toEqual({});
      const again = invalid(closed.next, NOW + 2 * DAY);
      const closedAgain = ok(again.next, NOW + 3 * DAY);

      expect(again.events[0].id).toBe(
        `channel.auth_invalid:int-1:${UPDATED}-${NOW + 2 * DAY}`
      );
      expect(again.events[0].id).not.toBe(first.events[0].id);

      // Each way back names the problem it closes.
      expect(closed.events[0].id).toBe(
        `channel.reconnected:int-1:${UPDATED}-${NOW}`
      );
      expect(closedAgain.events[0].id).toBe(
        `channel.reconnected:int-1:${UPDATED}-${NOW + 2 * DAY}`
      );
      expect(closed.events[0].id).not.toBe(closedAgain.events[0].id);
    });

    it('reads the state 0.7.0 wrote to Redis', () => {
      const old = {
        'int-1': {
          kind: 'channel.auth_invalid' as const,
          updatedAt: UPDATED,
          since: '2026-10-26T06:00:00.000Z',
        },
      };
      expect(invalid(old, NOW).events).toEqual([]);
      const closed = ok(old, NOW);
      expect(closed.events[0].id).toBe(
        `channel.reconnected:int-1:${UPDATED}-${Date.parse(
          '2026-10-26T06:00:00.000Z'
        )}`
      );
    });

    it('ends the id on -0 when since is broken, without crashing', () => {
      const broken = {
        'int-1': {
          kind: 'channel.auth_invalid' as const,
          updatedAt: UPDATED,
          since: 'not a date',
        },
      };
      const closed = ok(broken, NOW);
      expect(closed.events[0].id).toBe(
        `channel.reconnected:int-1:${UPDATED}-0`
      );
    });

    it('keeps the id of "getrennt" at flag and updatedAt', () => {
      const first = diffChannels({
        previous: {},
        channels: [channel({ disabled: true })],
        now: NOW,
      });
      expect(first.events[0].id).toBe(
        `channel.disconnected:int-1:disabled-${UPDATED}`
      );
      const later = diffChannels({
        previous: {},
        channels: [channel({ disabled: true })],
        now: NOW + 5 * DAY,
      });
      expect(later.events[0].id).toBe(first.events[0].id);
      const closed = diffChannels({
        previous: first.next,
        channels: [channel({ updatedAt: new Date(NOW + 1000) })],
        now: NOW + DAY,
      });
      expect(closed.events[0].id).toBe(
        `channel.reconnected:int-1:${NOW + 1000}-${NOW}`
      );
    });
  });

  describe('"Zugang ungültig" ends only with a new token or a passed call', () => {
    const OLD_EXP = NOW + 30 * DAY;
    const NEW_EXP = NOW + 60 * DAY;
    const UPDATED = NOW - DAY;
    const RENAMED = NOW + 1000;
    const renamed = (patch: Partial<ChannelRow> = {}) =>
      channel({
        name: 'Y Social Umbenannt',
        updatedAt: new Date(RENAMED),
        ...patch,
      });
    const reported = (row: ChannelRow = channel()) =>
      diffChannels({
        previous: {},
        channels: [row],
        now: NOW,
        authInvalid: { 'int-1': 'x' },
      });
    const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

    it('keeps it after a rename in the hourly check, state unchanged', () => {
      const first = reported();
      const hourly = diffChannels({
        previous: first.next,
        channels: [renamed()],
        now: NOW + 3600_000,
      });
      expect(hourly.events).toEqual([]);
      expect(hourly.next).toEqual(first.next);
      expect(hourly.next['int-1']).toMatchObject({
        since: new Date(NOW).toISOString(),
        updatedAt: UPDATED,
        tokenExpiration: OLD_EXP,
      });
    });

    it('closes it with a new tokenExpiration and names the new updatedAt', () => {
      const first = reported();
      const hourly = diffChannels({
        previous: first.next,
        channels: [renamed({ tokenExpiration: new Date(NEW_EXP) })],
        now: NOW + 3600_000,
      });
      expect(hourly.events).toHaveLength(1);
      expect(hourly.events[0].id).toBe(
        `channel.reconnected:int-1:${RENAMED}-${NOW}`
      );
      expect(hourly.events[0].kind).toBe('channel.reconnected');
      expect(hourly.events[0].data).toEqual({
        previous: 'channel.auth_invalid',
      });
      expect(hourly.next).toEqual({});
    });

    it('keeps it for null stored and null at the channel', () => {
      const first = reported(channel({ tokenExpiration: null }));
      expect(first.next['int-1'].tokenExpiration).toBeNull();
      const hourly = diffChannels({
        previous: first.next,
        channels: [renamed({ tokenExpiration: null })],
        now: NOW + 3600_000,
      });
      expect(hourly.events).toEqual([]);
      expect(hourly.next).toEqual(first.next);
    });

    it('closes it when null stored and the channel gets a date', () => {
      const first = reported(channel({ tokenExpiration: null }));
      const hourly = diffChannels({
        previous: first.next,
        channels: [renamed({ tokenExpiration: new Date(NEW_EXP) })],
        now: NOW + 3600_000,
      });
      expect(kinds(hourly.events)).toEqual(['channel.reconnected']);
      expect(hourly.next).toEqual({});
    });

    it('closes it when a date is stored and the channel gets null', () => {
      const first = reported();
      const hourly = diffChannels({
        previous: first.next,
        channels: [renamed({ tokenExpiration: null })],
        now: NOW + 3600_000,
      });
      expect(kinds(hourly.events)).toEqual(['channel.reconnected']);
      expect(hourly.next).toEqual({});
    });

    describe('state of 0.7.4 without tokenExpiration', () => {
      const old = {
        'int-1': {
          kind: 'channel.auth_invalid' as const,
          updatedAt: UPDATED,
          since: '2026-10-26T06:00:00.000Z',
        },
      };

      it('stays open for a new updatedAt and a new tokenExpiration', () => {
        const result = diffChannels({
          previous: old,
          channels: [renamed({ tokenExpiration: new Date(NEW_EXP) })],
          now: NOW,
        });
        expect(result.events).toEqual([]);
        expect(result.next).toEqual(old);
      });

      it('closes with authOk', () => {
        const result = diffChannels({
          previous: old,
          channels: [renamed()],
          now: NOW,
          authOk: ['int-1'],
        });
        expect(kinds(result.events)).toEqual(['channel.reconnected']);
        expect(result.events[0].id).toBe(
          `channel.reconnected:int-1:${RENAMED}-${Date.parse(
            '2026-10-26T06:00:00.000Z'
          )}`
        );
        expect(result.next).toEqual({});
      });
    });

    describe('state that went through Redis as JSON', () => {
      const viaRedis = (state: ReturnType<typeof reported>['next']) =>
        JSON.parse(JSON.stringify(state));

      it('keeps the rule for a date', () => {
        const stored = viaRedis(reported().next);
        expect(stored['int-1'].tokenExpiration).toBe(OLD_EXP);
        const rename = diffChannels({
          previous: stored,
          channels: [renamed()],
          now: NOW + 3600_000,
        });
        expect(rename.events).toEqual([]);
        expect(rename.next).toEqual(stored);
        const token = diffChannels({
          previous: stored,
          channels: [renamed({ tokenExpiration: new Date(NEW_EXP) })],
          now: NOW + 3600_000,
        });
        expect(kinds(token.events)).toEqual(['channel.reconnected']);
      });

      it('keeps the rule for null', () => {
        const stored = viaRedis(
          reported(channel({ tokenExpiration: null })).next
        );
        // null stays in JSON, it is not dropped like undefined.
        expect(stored['int-1']).toHaveProperty('tokenExpiration', null);
        const rename = diffChannels({
          previous: stored,
          channels: [renamed({ tokenExpiration: null })],
          now: NOW + 3600_000,
        });
        expect(rename.events).toEqual([]);
        expect(rename.next).toEqual(stored);
        const token = diffChannels({
          previous: stored,
          channels: [renamed({ tokenExpiration: new Date(NEW_EXP) })],
          now: NOW + 3600_000,
        });
        expect(kinds(token.events)).toEqual(['channel.reconnected']);
      });
    });

    it('closes it after a rename in the same run as a passed call', () => {
      const first = reported();
      const daily = diffChannels({
        previous: first.next,
        channels: [renamed()],
        now: NOW + DAY,
        authOk: ['int-1'],
      });
      expect(kinds(daily.events)).toEqual(['channel.reconnected']);
      expect(daily.events[0].id).toBe(
        `channel.reconnected:int-1:${RENAMED}-${NOW}`
      );
      expect(daily.next).toEqual({});
    });

    it('says nothing new for a rename while the platform still refuses', () => {
      const first = reported();
      const daily = diffChannels({
        previous: first.next,
        channels: [renamed()],
        now: NOW + DAY,
        authInvalid: { 'int-1': 'x' },
      });
      expect(daily.events).toEqual([]);
      expect(daily.next).toEqual(first.next);
    });

    it('still reports a flag set after auth_invalid as disconnected', () => {
      const first = reported();
      const flagged = diffChannels({
        previous: first.next,
        channels: [renamed({ refreshNeeded: true })],
        now: NOW + 3600_000,
      });
      expect(kinds(flagged.events)).toEqual(['channel.disconnected']);
      expect(flagged.events[0].id).toBe(
        `channel.disconnected:int-1:refresh_needed-${RENAMED}`
      );
      expect(flagged.next['int-1'].kind).toBe('channel.disconnected');
    });
  });

  it('reports a reported channel that was removed in Postiz', () => {
    const before = diffChannels({
      previous: {},
      channels: [channel({ disabled: true })],
      now: NOW,
    });
    const after = diffChannels({
      previous: before.next,
      channels: [],
      now: NOW + 3600_000,
    });
    expect(after.events.map((e) => e.kind)).toEqual(['channel.removed']);
    expect(after.events[0].subject).toEqual({ type: 'channel', id: 'int-1' });
    expect(after.next).toEqual({});
  });

  it('says nothing about healthy channels', () => {
    expect(
      diffChannels({
        previous: {},
        channels: [channel(), channel({ id: 'int-2' })],
        now: NOW,
      })
    ).toEqual({
      events: [],
      next: {},
    });
  });
});

describe('berlinDay', () => {
  it('uses the calendar day in Berlin', () => {
    expect(berlinDay(Date.parse('2026-10-26T23:30:00.000Z'))).toBe(
      '2026-10-27'
    );
    expect(berlinDay(Date.parse('2026-10-26T05:00:00.000Z'))).toBe(
      '2026-10-26'
    );
  });
});

describe('problemChanges', () => {
  const problem = (patch = {}) => ({
    kind: 'channel.auth_invalid' as const,
    updatedAt: NOW - DAY,
    since: String(NOW),
    ...patch,
  });

  it('is empty for an unchanged state', () => {
    const state = { 'int-1': problem(), 'int-2': problem() };
    expect(problemChanges(state, { ...state })).toEqual({});
    expect(problemChanges({}, {})).toEqual({});
  });

  it('has no state before for a new channel', () => {
    expect(problemChanges({}, { 'int-1': problem() })).toEqual({
      'int-1': { before: null, after: problem() },
    });
  });

  it('has both states when kind, since or updatedAt changed', () => {
    const previous = { 'int-1': problem(), 'int-2': problem() };
    expect(
      problemChanges(previous, {
        'int-1': problem({ since: String(NOW + DAY) }),
        'int-2': problem(),
      })
    ).toEqual({
      'int-1': {
        before: problem(),
        after: problem({ since: String(NOW + DAY) }),
      },
    });
    expect(
      problemChanges(previous, {
        'int-1': problem({ updatedAt: NOW }),
        'int-2': problem({ kind: 'channel.disconnected' }),
      })
    ).toEqual({
      'int-1': { before: problem(), after: problem({ updatedAt: NOW }) },
      'int-2': {
        before: problem(),
        after: problem({ kind: 'channel.disconnected' }),
      },
    });
  });

  it('has no state after for a solved channel', () => {
    expect(
      problemChanges(
        { 'int-1': problem(), 'int-2': problem() },
        { 'int-2': problem() }
      )
    ).toEqual({ 'int-1': { before: problem(), after: null } });
  });
});

describe('applyProblemChanges', () => {
  const problem = (n: number) => ({
    kind: 'channel.auth_invalid' as const,
    updatedAt: NOW - DAY,
    since: String(n),
  });

  it('sets and deletes only the named channels', () => {
    const current = {
      'int-1': problem(1),
      'int-2': problem(2),
      'int-3': problem(3),
    };
    expect(
      applyProblemChanges(current, {
        'int-1': { before: problem(1), after: null },
        'int-4': { before: null, after: problem(4) },
      })
    ).toEqual({
      'int-2': problem(2),
      'int-3': problem(3),
      'int-4': problem(4),
    });
    expect(Object.keys(current)).toEqual(['int-1', 'int-2', 'int-3']);
  });

  it('keeps a channel that is no longer in the state the run started from', () => {
    const changed = { ...problem(1), kind: 'channel.disconnected' as const };
    const changes: ChannelProblemChanges = {
      'int-1': { before: problem(1), after: null },
      'int-2': { before: null, after: problem(2) },
      'int-3': { before: problem(3), after: problem(4) },
    };
    expect(
      applyProblemChanges({ 'int-1': changed, 'int-2': problem(9) }, changes)
    ).toEqual({ 'int-1': changed, 'int-2': problem(9) });
  });

  it('gives the same state when applied twice', () => {
    const changes: ChannelProblemChanges = {
      'int-1': { before: problem(1), after: null },
      'int-2': { before: null, after: problem(9) },
      'int-3': { before: problem(3), after: problem(4) },
    };
    const current = { 'int-1': problem(1), 'int-3': problem(3) };
    const once = applyProblemChanges(current, changes);
    expect(once).toEqual({ 'int-2': problem(9), 'int-3': problem(4) });
    expect(applyProblemChanges(once, changes)).toEqual(once);
  });

  it('ignores a deletion of a channel that is not there', () => {
    expect(
      applyProblemChanges({}, { 'int-1': { before: problem(1), after: null } })
    ).toEqual({});
  });
});

describe('a check that runs between preparing and saving', () => {
  const DAILY = NOW;
  const HOURLY = NOW + 1000;
  const NEXT_HOURLY = NOW + 3600_000;
  const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

  it('does not undo a disconnect the hourly check found (L1)', () => {
    const x = channel({ id: 'X' });
    const flagged = channel({ id: 'X', refreshNeeded: true });
    const reported = diffChannels({
      previous: {},
      channels: [x],
      now: NOW - DAY,
      authInvalid: { X: 'expired' },
    }).next;
    expect(reported.X.kind).toBe('channel.auth_invalid');

    const daily = diffChannels({
      previous: reported,
      channels: [x],
      now: DAILY,
      authOk: ['X'],
    });
    const changes = problemChanges(reported, daily.next);
    expect(kinds(daily.events)).toEqual(['channel.reconnected']);
    expect(changes).toEqual({ X: { before: reported.X, after: null } });

    const hourly = diffChannels({
      previous: reported,
      channels: [flagged],
      now: HOURLY,
    });
    expect(kinds(hourly.events)).toEqual(['channel.disconnected']);

    const saved = applyProblemChanges(hourly.next, changes);
    expect(saved.X.kind).toBe('channel.disconnected');

    const later = diffChannels({
      previous: saved,
      channels: [x],
      now: NEXT_HOURLY,
    });
    expect(kinds(later.events)).toEqual(['channel.reconnected']);
  });

  it('does not bring back a problem the hourly check solved (L5)', () => {
    const x = channel({ id: 'X' });
    const reported = diffChannels({
      previous: {},
      channels: [channel({ id: 'X', disabled: true })],
      now: NOW - DAY,
    }).next;
    expect(reported.X.kind).toBe('channel.disconnected');

    const daily = diffChannels({
      previous: reported,
      channels: [x],
      now: DAILY,
      authInvalid: { X: 'expired' },
    });
    const changes = problemChanges(reported, daily.next);
    expect(kinds(daily.events)).toEqual(['channel.auth_invalid']);
    expect(changes.X).toEqual({ before: reported.X, after: daily.next.X });

    const hourly = diffChannels({
      previous: reported,
      channels: [x],
      now: HOURLY,
    });
    expect(kinds(hourly.events)).toEqual(['channel.reconnected']);
    expect(hourly.next).toEqual({});

    const saved = applyProblemChanges(hourly.next, changes);
    expect(saved).toEqual({});

    const nextDaily = diffChannels({
      previous: saved,
      channels: [x],
      now: DAILY + DAY,
      authInvalid: { X: 'expired' },
    });
    expect(kinds(nextDaily.events)).toEqual(['channel.auth_invalid']);
    expect(nextDaily.events[0].id).not.toBe(daily.events[0].id);
  });

  it('does not let a second DailyHealth run overwrite the first', () => {
    const x = channel({ id: 'X' });
    const run = (now: number) => {
      const { events, next } = diffChannels({
        previous: {},
        channels: [x],
        now,
        authInvalid: { X: 'expired' },
      });
      return { events, changes: problemChanges({}, next) };
    };
    const first = run(DAILY);
    const second = run(DAILY + 60_000);
    expect(first.changes.X.after!.since).not.toBe(
      second.changes.X.after!.since
    );

    const saved = applyProblemChanges(
      applyProblemChanges({}, first.changes),
      second.changes
    );
    expect(saved.X).toEqual(first.changes.X.after);
  });
});
