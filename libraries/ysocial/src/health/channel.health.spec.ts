import {
  berlinDay,
  channelFlag,
  ChannelRow,
  diffChannels,
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
