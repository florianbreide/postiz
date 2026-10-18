import {
  buildEventId,
  createHubEvent,
  deliveryWorkflowId,
  HUB_EVENT_REASON_MAX,
  HUB_EVENT_VERSION,
  sanitizeReason,
} from './hub.event';

const input = {
  kind: 'ping' as const,
  subject: { type: 'system' as const, id: 'ysocial-worker' },
  stateKey: 'ysocial-ping-qa',
  occurredAt: new Date('2026-10-19T07:00:00.000Z'),
  reason: 'Ping aus dem ysocial-Worker',
};

describe('createHubEvent', () => {
  it('builds the event of E35', () => {
    expect(createHubEvent(input)).toEqual({
      id: 'ping:ysocial-worker:ysocial-ping-qa',
      version: HUB_EVENT_VERSION,
      kind: 'ping',
      occurredAt: '2026-10-19T07:00:00.000Z',
      source: 'postiz',
      subject: { type: 'system', id: 'ysocial-worker' },
      postiz: {},
      reason: 'Ping aus dem ysocial-Worker',
    });
  });

  it('gives the same id for the same kind, subject and state', () => {
    const first = createHubEvent(input);
    const second = createHubEvent({
      ...input,
      occurredAt: '2026-10-19T08:00:00.000Z',
    });
    expect(second.id).toBe(first.id);
    expect(createHubEvent({ ...input, stateKey: 'other' }).id).not.toBe(
      first.id
    );
  });

  it('refuses unknown kinds and token or text fields', () => {
    expect(() =>
      createHubEvent({ ...input, kind: 'post.posted' as any })
    ).toThrow('unknown event kind');
    for (const key of [
      'token',
      'refreshToken',
      'accessToken',
      'content',
      'settings',
      'customInstanceDetails',
    ]) {
      expect(() => createHubEvent({ ...input, data: { [key]: 'x' } })).toThrow(
        key
      );
    }
  });

  it('refuses ids with spaces or without state', () => {
    expect(() => buildEventId('ping', 'a b', 'c')).toThrow();
    expect(() => buildEventId('ping', 'a', '')).toThrow();
    expect(() => buildEventId('ping', 'a', 'x'.repeat(500))).toThrow();
  });

  it('names the delivery workflow after the event', () => {
    expect(deliveryWorkflowId('ping:ysocial-worker:qa')).toBe(
      'ysocial-event-ping:ysocial-worker:qa'
    );
  });
});

describe('sanitizeReason', () => {
  it('removes credentials from platform errors', () => {
    const reason = sanitizeReason(
      'GET https://graph.facebook.com/v23.0/1_2/insights?metric=a&access_token=EAAGabc123 failed, Authorization: Bearer abc.def-ghi'
    );
    expect(reason).toContain('access_token=***');
    expect(reason).toContain('Bearer ***');
    expect(reason).not.toContain('EAAGabc123');
    expect(reason).not.toContain('abc.def-ghi');
  });

  it('removes long token-like strings', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeReason(`token ${long} invalid`)).toBe('token *** invalid');
  });

  it('shortens long texts and drops empty ones', () => {
    expect(sanitizeReason('word '.repeat(200))!.length).toBe(
      HUB_EVENT_REASON_MAX
    );
    expect(sanitizeReason('   ')).toBeUndefined();
    expect(sanitizeReason(undefined)).toBeUndefined();
  });
});
