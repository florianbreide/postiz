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
      channels: [channel({ updatedAt: new Date(NOW + 2 * 3600_000) })],
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

  it('has the new state of a new channel', () => {
    expect(problemChanges({}, { 'int-1': problem() })).toEqual({
      'int-1': problem(),
    });
  });

  it('has the new state when kind, since or updatedAt changed', () => {
    const previous = { 'int-1': problem(), 'int-2': problem() };
    expect(
      problemChanges(previous, {
        'int-1': problem({ since: String(NOW + DAY) }),
        'int-2': problem(),
      })
    ).toEqual({ 'int-1': problem({ since: String(NOW + DAY) }) });
    expect(
      problemChanges(previous, {
        'int-1': problem({ updatedAt: NOW }),
        'int-2': problem({ kind: 'channel.disconnected' }),
      })
    ).toEqual({
      'int-1': problem({ updatedAt: NOW }),
      'int-2': problem({ kind: 'channel.disconnected' }),
    });
  });

  it('has null for a solved channel', () => {
    expect(
      problemChanges(
        { 'int-1': problem(), 'int-2': problem() },
        {
          'int-2': problem(),
        }
      )
    ).toEqual({ 'int-1': null });
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
      applyProblemChanges(current, { 'int-1': null, 'int-4': problem(4) })
    ).toEqual({
      'int-2': problem(2),
      'int-3': problem(3),
      'int-4': problem(4),
    });
    expect(Object.keys(current)).toEqual(['int-1', 'int-2', 'int-3']);
  });

  it('gives the same state when applied twice', () => {
    const changes: ChannelProblemChanges = {
      'int-1': null,
      'int-2': problem(9),
    };
    const once = applyProblemChanges({ 'int-1': problem(1) }, changes);
    expect(applyProblemChanges(once, changes)).toEqual(once);
  });

  it('ignores a deletion of a channel that is not there', () => {
    expect(applyProblemChanges({}, { 'int-1': null })).toEqual({});
  });
});
