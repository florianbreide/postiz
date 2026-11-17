import {
  channelDataDeletedEvent,
  DELETION_DEADLINE_MS,
  deletionEnabled,
  deletionOverdue,
  graceCutoff,
  grantIdentities,
  inOwnStorage,
  postMediaRefs,
  revokeEnabled,
  revokeFinal,
  revokePlan,
  REVOKE_RESULTS,
  storageLocation,
} from './deletion.rules';

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-11-17T10:00:00.000Z');

describe('deletionEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(deletionEnabled({ YSOCIAL_DELETION_ENABLED: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', ' true']) {
      expect(deletionEnabled({ YSOCIAL_DELETION_ENABLED: value })).toBe(false);
    }
    expect(deletionEnabled({})).toBe(false);
  });
});

describe('grace period and deadline', () => {
  it('cuts off 6 days back', () => {
    expect(graceCutoff(NOW).getTime()).toBe(NOW.getTime() - 6 * DAY);
  });

  it('is overdue from exactly 7 days minus 2 hours', () => {
    const HOUR = 60 * 60_000;
    expect(DELETION_DEADLINE_MS).toBe(7 * DAY - 2 * HOUR);
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(deletionOverdue(at(DELETION_DEADLINE_MS - 1), NOW)).toBe(false);
    expect(deletionOverdue(at(DELETION_DEADLINE_MS), NOW)).toBe(true);
    expect(deletionOverdue(at(DELETION_DEADLINE_MS + 1), NOW)).toBe(true);
    expect(deletionOverdue(at(6 * DAY + 21 * HOUR), NOW)).toBe(false);
    expect(deletionOverdue(at(6 * DAY + 22 * HOUR), NOW)).toBe(true);
    expect(deletionOverdue(at(6 * DAY + 23 * HOUR), NOW)).toBe(true);
    expect(deletionOverdue(at(8 * DAY), NOW)).toBe(true);
    expect(deletionOverdue(at(6 * DAY), NOW)).toBe(false);
    expect(deletionOverdue(at(0), NOW)).toBe(false);
  });
});

describe('revokeEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(revokeEnabled({ YSOCIAL_DELETION_REVOKE: 'true' })).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true']) {
      expect(revokeEnabled({ YSOCIAL_DELETION_REVOKE: value })).toBe(false);
    }
    expect(revokeEnabled({ YSOCIAL_DELETION_ENABLED: 'true' })).toBe(false);
  });
});

describe('grantIdentities', () => {
  it('returns root and own id', () => {
    expect(
      grantIdentities({ internalId: 'page-1', rootInternalId: 'user-1' }).sort()
    ).toEqual(['page-1', 'user-1']);
  });

  it('skips a missing rootInternalId and de-duplicates', () => {
    expect(grantIdentities({ internalId: 'a', rootInternalId: null })).toEqual([
      'a',
    ]);
    expect(grantIdentities({ internalId: 'a', rootInternalId: 'a' })).toEqual([
      'a',
    ]);
  });

  it('unpacks deleted_<id>_<10 chars>, also with an underscore in the id', () => {
    expect(
      grantIdentities({
        internalId: 'deleted_12345_abcDEF1234',
        rootInternalId: null,
      })
    ).toEqual(['deleted_12345_abcDEF1234', '12345']);
    expect(
      grantIdentities({
        internalId: 'deleted_linkedin-page_123_abcDEF1234',
        rootInternalId: 'deleted_user_9_ZZZZZZZZZZ',
      }).sort()
    ).toEqual(
      [
        'deleted_linkedin-page_123_abcDEF1234',
        'linkedin-page_123',
        'deleted_user_9_ZZZZZZZZZZ',
        'user_9',
      ].sort()
    );
  });

  it('does not unpack other shapes', () => {
    expect(
      grantIdentities({ internalId: 'deleted_12345_short', rootInternalId: null })
    ).toEqual(['deleted_12345_short']);
    expect(
      grantIdentities({ internalId: 'xdeleted_1_abcDEF1234', rootInternalId: null })
    ).toEqual(['xdeleted_1_abcDEF1234']);
  });
});

describe('revokePlan', () => {
  const row = { internalId: 'p', rootInternalId: 'u' };

  it('is not_supported without a revoker, whatever else', () => {
    expect(revokePlan(row, false, true, [])).toBe('not_supported');
    expect(revokePlan(row, false, false, [])).toBe('not_supported');
    expect(
      revokePlan({ internalId: 'p', rootInternalId: null }, false, true, [
        { id: 'x', rootInternalId: null },
      ])
    ).toBe('not_supported');
  });

  it('is revoke_off when the switch is off, before any other check', () => {
    expect(revokePlan(row, true, false, [])).toBe('revoke_off');
    expect(
      revokePlan({ internalId: 'p', rootInternalId: null }, true, false, [
        { id: 'x', rootInternalId: null },
      ])
    ).toBe('revoke_off');
    expect(
      revokePlan(row, true, false, [{ id: 'a', rootInternalId: 'u' }])
    ).toBe('revoke_off');
  });

  it('is grant_unknown without rootInternalId on the row', () => {
    expect(
      revokePlan({ internalId: 'p', rootInternalId: null }, true, true, [])
    ).toBe('grant_unknown');
  });

  it('is grant_unknown when a holder has no rootInternalId, even with other holders', () => {
    expect(
      revokePlan(row, true, true, [
        { id: 'a', rootInternalId: 'u' },
        { id: 'b', rootInternalId: null },
      ])
    ).toBe('grant_unknown');
  });

  it('is shared_grant with a holder and revoke without', () => {
    expect(revokePlan(row, true, true, [{ id: 'a', rootInternalId: 'u' }])).toBe(
      'shared_grant'
    );
    expect(revokePlan(row, true, true, [])).toBe('revoke');
  });
});

describe('revokeFinal', () => {
  it('is final only for the settled results', () => {
    const final = REVOKE_RESULTS.filter(revokeFinal);
    expect(final.sort()).toEqual(
      [
        'revoked',
        'already_invalid',
        'no_refresh_token',
        'token_mismatch',
        'not_supported',
        'revoke_off',
        'shared_grant',
        'grant_unknown',
      ].sort()
    );
    for (const open of ['failed', 'not_configured', 'changed_meanwhile'] as const) {
      expect(revokeFinal(open)).toBe(false);
    }
  });
});

describe('postMediaRefs', () => {
  it('reads an image list', () => {
    const image = JSON.stringify([
      { id: 'm1', path: 'https://x.test/uploads/a.png', alt: 'a' },
      { id: 'm2', path: 'https://x.test/uploads/b.png', thumbnail: 't' },
    ]);
    expect(postMediaRefs(image)).toEqual({
      ids: ['m1', 'm2'],
      paths: ['https://x.test/uploads/a.png', 'https://x.test/uploads/b.png'],
    });
  });

  it('finds nested settings and merges several values without duplicates', () => {
    const settings = JSON.stringify({
      a: { b: [{ thumbnail: { id: 'm3', path: 'https://x.test/uploads/t.png' } }] },
    });
    const image = JSON.stringify([
      { id: 'm3', path: 'https://x.test/uploads/t.png' },
    ]);
    expect(postMediaRefs(image, settings)).toEqual({
      ids: ['m3'],
      paths: ['https://x.test/uploads/t.png'],
    });
  });

  it('ignores objects without string id and path, empty strings and broken input', () => {
    expect(
      postMediaRefs(
        JSON.stringify([{ id: 1, path: 'p' }, { id: 'x' }, { path: 'p' }]),
        JSON.stringify([{ id: '', path: '' }])
      )
    ).toEqual({ ids: [], paths: [] });
    expect(postMediaRefs('{not json', 'null', '', null, undefined)).toEqual({
      ids: [],
      paths: [],
    });
    expect(postMediaRefs('"text"', '42', '[]')).toEqual({ ids: [], paths: [] });
  });

  it('stops at depth 8', () => {
    let deep: unknown = { id: 'deep', path: 'p' };
    for (let i = 0; i < 12; i++) {
      deep = { next: deep };
    }
    expect(postMediaRefs(JSON.stringify(deep))).toEqual({ ids: [], paths: [] });
  });
});

describe('storageLocation and inOwnStorage', () => {
  it('uses FRONTEND_URL/uploads for local storage, with subfolders allowed', () => {
    const location = storageLocation({ FRONTEND_URL: 'https://app.test' });
    expect(location).toEqual({ prefix: 'https://app.test/uploads/', flat: false });
    expect(
      storageLocation({ STORAGE_PROVIDER: 'local', FRONTEND_URL: 'https://app.test' })
    ).toEqual(location);
    // local.storage.ts stores FRONTEND_URL + '/uploads' verbatim, so the
    // prefix follows it, also with a trailing slash in FRONTEND_URL.
    expect(
      storageLocation({ STORAGE_PROVIDER: 'local', FRONTEND_URL: 'https://app.test/' })
    ).toEqual({ prefix: 'https://app.test//uploads/', flat: false });
    expect(inOwnStorage('https://app.test/uploads/2026/11/a.png', location)).toBe(
      true
    );
  });

  it('uses CLOUDFLARE_BUCKET_URL for cloudflare, flat', () => {
    const location = storageLocation({
      STORAGE_PROVIDER: 'cloudflare',
      CLOUDFLARE_BUCKET_URL: 'https://cdn.test//',
      FRONTEND_URL: 'https://app.test',
    });
    expect(location).toEqual({ prefix: 'https://cdn.test/', flat: true });
    expect(inOwnStorage('https://cdn.test/a.png', location)).toBe(true);
  });

  it('on cloudflare no slash may follow the prefix', () => {
    const location = storageLocation({
      STORAGE_PROVIDER: 'cloudflare',
      CLOUDFLARE_BUCKET_URL: 'https://cdn.test',
    });
    expect(inOwnStorage('https://cdn.test/x/y.png', location)).toBe(false);
    expect(inOwnStorage('https://cdn.test/x/', location)).toBe(false);
    expect(inOwnStorage('https://cdn.test//y.png', location)).toBe(false);
    expect(inOwnStorage('https://cdn.test/y.png', location)).toBe(true);
  });

  it('is undefined without the variable', () => {
    expect(storageLocation({})).toBeUndefined();
    expect(storageLocation({ STORAGE_PROVIDER: 'cloudflare' })).toBeUndefined();
    expect(
      storageLocation({ STORAGE_PROVIDER: 'cloudflare', FRONTEND_URL: 'https://a.test' })
    ).toBeUndefined();
    expect(storageLocation({ CLOUDFLARE_BUCKET_URL: 'https://c.test' })).toBeUndefined();
  });

  it('never treats a file as own without a location, outside it, or with ..', () => {
    const location = storageLocation({ FRONTEND_URL: 'https://app.test' });
    expect(inOwnStorage('https://app.test/uploads/a/b.png', location)).toBe(true);
    expect(inOwnStorage('https://app.test/uploads/a.png', undefined)).toBe(false);
    expect(inOwnStorage('https://app.test/uploads/', location)).toBe(false);
    expect(inOwnStorage('https://app.test/uploads/../etc/x', location)).toBe(false);
    expect(inOwnStorage('https://app.test/uploads/a..b.png', location)).toBe(false);
    expect(inOwnStorage('https://other.test/uploads/a.png', location)).toBe(false);
    expect(inOwnStorage('https://app.test.evil.test/uploads/a.png', location)).toBe(
      false
    );
    expect(inOwnStorage('/uploads/a.png', location)).toBe(false);
  });
});

describe('channelDataDeletedEvent', () => {
  const channel = {
    id: 'int-1',
    organizationId: 'org-1',
    customerId: null as string | null,
    providerIdentifier: 'facebook',
    deletedAt: new Date('2026-11-10T08:00:00.000Z'),
  };
  const media = { deleted: 2, kept: 1, failed: 0, left: 0 };

  it('builds a channel event with id kind:id:deletedAt-ms', () => {
    const event = channelDataDeletedEvent(channel, 'revoked', media, false, NOW);
    expect(event.id).toBe(
      `channel.data_deleted:int-1:${channel.deletedAt.getTime()}`
    );
    expect(event.kind).toBe('channel.data_deleted');
    expect(event.subject).toEqual({ type: 'channel', id: 'int-1' });
    expect(event.occurredAt).toBe(NOW.toISOString());
    expect(event.postiz).toMatchObject({
      organizationId: 'org-1',
      integrationId: 'int-1',
      customerId: null,
      providerIdentifier: 'facebook',
    });
    expect(event.data).toEqual({
      deletedAt: channel.deletedAt.toISOString(),
      revoke: 'revoked',
      mediaDeleted: 2,
      mediaKept: 1,
      mediaFailed: 0,
      mediaLeft: 0,
      overdue: false,
    });
  });

  it('has no token key and the reason holds no token', () => {
    const event = channelDataDeletedEvent(
      { ...channel, customerId: 'cust-1' },
      'failed',
      { deleted: 0, kept: 0, failed: 1, left: 3 },
      true,
      NOW
    );
    expect(Object.keys(event.data || {}).join(' ')).not.toMatch(/token/i);
    expect(event.reason).toContain('4 nicht gelöscht');
    expect(event.reason).not.toMatch(/token\s*[:=]/i);
    expect((event.data as any).overdue).toBe(true);
    expect(event.postiz.customerId).toBe('cust-1');
  });

  it('gives a new id for a channel deleted again later', () => {
    const first = channelDataDeletedEvent(channel, 'revoked', media, false, NOW);
    const second = channelDataDeletedEvent(
      { ...channel, deletedAt: new Date('2026-11-12T08:00:00.000Z') },
      'revoked',
      media,
      false,
      NOW
    );
    expect(second.id).not.toBe(first.id);
  });
});
