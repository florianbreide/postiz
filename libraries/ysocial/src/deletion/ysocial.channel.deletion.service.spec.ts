import { Logger } from '@nestjs/common';

// The real factory loads the storage SDKs. The tests hand the service its file
// store directly.
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: jest.fn() },
}));

import { DELETION_MEDIA_BUDGET_MS } from './deletion.rules';
import {
  YsocialChannelDeletionService,
  YsocialFileStore,
} from './ysocial.channel.deletion.service';

// Invented channels and fake tokens, which must never show up in a log.
const TOKEN = 'test-page-token-1';
const REFRESH = 'test-refresh-token-1';
const NOW = new Date('2026-11-17T10:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const UPLOADS = 'https://app.test/uploads';
const SECRETS = [TOKEN, REFRESH, 'test-access-token-2', 'test-client-secret'];

const reply = (status: number, body?: unknown) => ({
  status,
  json: async () => {
    if (body === undefined) {
      throw new Error('no json');
    }
    return body;
  },
});

const channel = (patch: Record<string, unknown> = {}) => ({
  id: 'int-1',
  organizationId: 'org-1',
  customerId: null as string | null,
  internalId: 'openid1',
  rootInternalId: 'user-1',
  providerIdentifier: 'tiktok',
  deletedAt: new Date(NOW.getTime() - 8 * DAY),
  updatedAt: new Date(NOW.getTime() - 8 * DAY),
  token: TOKEN,
  refreshToken: REFRESH,
  ...patch,
});

const medium = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  path: `${UPLOADS}/${id}.png`,
  thumbnail: null as string | null,
  _count: { userPicture: 0, agencies: 0, oauthApps: 0 },
  ...patch,
});

const postWith = (ids: string[]) => ({
  image: JSON.stringify(
    ids.map((id) => ({ id, path: `${UPLOADS}/${id}.png` }))
  ),
  settings: '{}',
});

class TestService extends YsocialChannelDeletionService {
  constructor(repository: any, store: YsocialFileStore, clock?: () => number) {
    super(repository);
    this.files = () => store;
    if (clock) {
      this.clock = clock;
    }
  }
}

const setup = (
  options: {
    row?: any;
    holders?: any[][];
    unchanged?: boolean[];
    cleared?: number;
    posts?: any[];
    media?: any[];
    inUse?: (item: any) => boolean;
    removeFile?: (path: string) => Promise<void>;
    due?: any[];
    clock?: () => number;
  } = {}
) => {
  const row = options.row === undefined ? channel() : options.row;
  const holders = [...(options.holders ?? [])];
  const unchanged = [...(options.unchanged ?? [])];
  const repository = {
    getDeletedChannels: jest.fn().mockResolvedValue(options.due ?? []),
    getChannelForDeletion: jest.fn().mockResolvedValue(row),
    getGrantHolders: jest.fn(async (_params: any) => holders.shift() ?? []),
    isUnchanged: jest.fn(async () => (unchanged.length ? unchanged.shift() : true)),
    clearTokens: jest.fn().mockResolvedValue(options.cleared ?? 1),
    getPostMedia: jest.fn().mockResolvedValue(options.posts ?? []),
    getMedia: jest.fn().mockResolvedValue(options.media ?? []),
    mediaInUse: jest.fn(async (item: any) => options.inUse?.(item) ?? false),
    deleteMedia: jest.fn().mockResolvedValue(1),
  };
  const store = {
    removeFile: jest.fn(options.removeFile ?? (async () => undefined)),
  };
  return {
    service: new TestService(repository, store, options.clock),
    repository,
    store,
  };
};

const env = { ...process.env };
let fetchMock: jest.Mock;
let lines: string[];

beforeEach(() => {
  fetchMock = jest.fn(async (url: string) =>
    url.includes('/oauth/token/')
      ? reply(200, { access_token: 'test-access-token-2', open_id: 'open-id-1' })
      : reply(200, {})
  );
  (global as any).fetch = fetchMock;
  process.env = {
    ...env,
    FRONTEND_URL: 'https://app.test',
    TIKTOK_CLIENT_ID: 'test-client-key',
    TIKTOK_CLIENT_SECRET: 'test-client-secret',
  };
  delete process.env.STORAGE_PROVIDER;
  delete process.env.CLOUDFLARE_BUCKET_URL;
  delete process.env.YSOCIAL_DELETION_ENABLED;
  delete process.env.YSOCIAL_DELETION_REVOKE;
  lines = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: any, ...rest: any[]) => {
        lines.push([message, ...rest].map(String).join(' '));
      });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = env;
});

const on = () => {
  process.env.YSOCIAL_DELETION_ENABLED = 'true';
};
const revokeOn = () => {
  process.env.YSOCIAL_DELETION_REVOKE = 'true';
};

// A row whose token cannot be decrypted: the getter throws.
const unreadable = (patch: Record<string, unknown> = {}) => {
  const row = channel(patch);
  Object.defineProperty(row, 'token', {
    get() {
      throw new Error(`cannot decrypt ${TOKEN}`);
    },
    enumerable: true,
  });
  return row;
};

const calls = (fragment: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));

afterEach(() => {
  // No log line of any test holds a token value.
  for (const line of lines) {
    for (const secret of SECRETS) {
      expect(line).not.toContain(secret);
    }
  }
});

describe('findDue', () => {
  const dueRow = (id: string, token = TOKEN, refreshToken: string | null = null) => ({
    id,
    deletedAt: new Date(NOW.getTime() - 8 * DAY),
    token,
    refreshToken,
  });

  it('keeps only rows with a token or refreshToken, empty string does not count', async () => {
    const { service, repository } = setup({
      due: [
        dueRow('a'),
        dueRow('b', '', null),
        dueRow('c', '', REFRESH),
        dueRow('d', '', ''),
      ],
    });
    const result = await service.findDue(NOW);
    expect(result).toEqual({ dryRun: true, due: 2, integrationIds: ['a', 'c'] });
    expect(repository.getDeletedChannels).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 6 * DAY)
    );
  });

  it('counts a row with an unreadable token as due', async () => {
    const broken = dueRow('broken');
    Object.defineProperty(broken, 'token', {
      get() {
        throw new Error('cannot decrypt');
      },
    });
    const { service } = setup({ due: [dueRow('a'), broken, dueRow('b', '', '')] });
    expect(await service.findDue(NOW)).toMatchObject({
      due: 2,
      integrationIds: ['a', 'broken'],
    });
  });

  it('returns at most 25 ids but counts all, and no token', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => dueRow(`id-${i}`));
    const { service } = setup({ due: rows });
    const result = await service.findDue(NOW);
    expect(result.due).toBe(30);
    expect(result.integrationIds).toHaveLength(25);
    expect(result.integrationIds[0]).toBe('id-0');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports dryRun by YSOCIAL_DELETION_ENABLED', async () => {
    const { service } = setup();
    expect((await service.findDue(NOW)).dryRun).toBe(true);
    on();
    expect((await service.findDue(NOW)).dryRun).toBe(false);
  });
});

describe('deleteChannelData: nothing to do', () => {
  const none = async (options: Parameters<typeof setup>[0]) => {
    on();
    const { service, repository, store } = setup(options);
    expect(await service.deleteChannelData('int-1', NOW)).toEqual({
      result: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.clearTokens).not.toHaveBeenCalled();
    expect(repository.deleteMedia).not.toHaveBeenCalled();
    expect(store.removeFile).not.toHaveBeenCalled();
  };

  it('for an unknown channel', () => none({ row: null }));
  it('for a channel connected again (deletedAt null)', () =>
    none({ row: channel({ deletedAt: null }) }));
  it('for a channel still in its grace period', () =>
    none({ row: channel({ deletedAt: new Date(NOW.getTime() - 5 * DAY) }) }));
  it('for a channel deleted one second after the cutoff', () =>
    none({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6 * DAY + 1000) }),
    }));
  it('for a channel whose tokens are already empty', () =>
    none({ row: channel({ token: '', refreshToken: null }) }));
  it('for empty token and empty refreshToken strings', () =>
    none({ row: channel({ token: '', refreshToken: '' }) }));

  it('does not skip a channel whose token cannot be read', async () => {
    const { service } = setup({ row: unreadable() });
    expect((await service.deleteChannelData('int-1', NOW)).result).not.toBeNull();
  });

  it('works exactly at the cutoff', async () => {
    const { service } = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6 * DAY) }),
    });
    expect((await service.deleteChannelData('int-1', NOW)).result).not.toBeNull();
  });
});

describe('deleteChannelData: dry run', () => {
  for (const value of [undefined, 'false', 'TRUE', '1', '', 'yes']) {
    it(`does nothing for YSOCIAL_DELETION_ENABLED=${JSON.stringify(value)}`, async () => {
      if (value !== undefined) {
        process.env.YSOCIAL_DELETION_ENABLED = value;
      }
      revokeOn();
      const { service, repository, store } = setup({
        posts: [postWith(['m1', 'm2'])],
        media: [medium('m1'), medium('m2')],
      });
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(event).toBeUndefined();
      expect(result).toMatchObject({
        integrationId: 'int-1',
        providerIdentifier: 'tiktok',
        mode: 'dry_run',
        status: 'planned',
        revoke: 'revoke',
        overdue: true,
        media: { deleted: 2, kept: 0, failed: 0, left: 0 },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(repository.clearTokens).not.toHaveBeenCalled();
      expect(repository.deleteMedia).not.toHaveBeenCalled();
      expect(repository.isUnchanged).not.toHaveBeenCalled();
      expect(store.removeFile).not.toHaveBeenCalled();
    });
  }

  it('does not even create the file store', async () => {
    const { repository } = setup({ posts: [postWith(['m1'])], media: [medium('m1')] });
    const files = jest.fn();
    class Probe extends YsocialChannelDeletionService {
      constructor() {
        super(repository as any);
        this.files = files;
      }
    }
    await new Probe().deleteChannelData('int-1', NOW);
    expect(files).not.toHaveBeenCalled();
  });

  it('plans revoke_off without the REVOKE switch and asks nobody', async () => {
    const { service, repository } = setup();
    expect((await service.deleteChannelData('int-1', NOW)).result?.revoke).toBe(
      'revoke_off'
    );
    expect(repository.getGrantHolders).not.toHaveBeenCalled();
  });

  it('plans the revoke as the rules say with the REVOKE switch on', async () => {
    revokeOn();
    const shared = setup({ holders: [[{ id: 'other', rootInternalId: 'user-1' }]] });
    expect((await shared.service.deleteChannelData('int-1', NOW)).result?.revoke).toBe(
      'shared_grant'
    );
    for (const provider of ['linkedin', 'facebook', 'youtube', 'instagram-standalone']) {
      const none = setup({ row: channel({ providerIdentifier: provider }) });
      expect((await none.service.deleteChannelData('int-1', NOW)).result?.revoke).toBe(
        'not_supported'
      );
      expect(none.repository.getGrantHolders).not.toHaveBeenCalled();
    }
    const unknown = setup({ row: channel({ rootInternalId: null }) });
    expect(
      (await unknown.service.deleteChannelData('int-1', NOW)).result?.revoke
    ).toBe('grant_unknown');
    expect(unknown.repository.getGrantHolders).not.toHaveBeenCalled();
  });

  it('asks for holders of the family with the identities and cutoff', async () => {
    revokeOn();
    const { service, repository } = setup({
      row: channel({ internalId: 'deleted_openid1_abcDEF1234' }),
    });
    await service.deleteChannelData('int-1', NOW);
    const params = repository.getGrantHolders.mock.calls[0][0] as any;
    expect(params.id).toBe('int-1');
    expect(params.providers).toEqual(['tiktok']);
    expect(params.identities.sort()).toEqual(
      ['deleted_openid1_abcDEF1234', 'openid1', 'user-1'].sort()
    );
    expect(params.graceCutoff).toEqual(new Date(NOW.getTime() - 6 * DAY));
  });

  it('throws an error of planRevoke on, also past the deadline', async () => {
    revokeOn();
    const { service, repository } = setup();
    repository.getGrantHolders.mockRejectedValue(new Error('db down'));
    await expect(service.deleteChannelData('int-1', NOW)).rejects.toThrow('db down');
    expect(repository.clearTokens).not.toHaveBeenCalled();
  });
});

describe('deleteChannelData: on', () => {
  beforeEach(on);

  it('without the REVOKE switch: no platform call, no holder lookup, tokens cleared, event', async () => {
    const { service, repository } = setup();
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'revoke_off', mode: 'on' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.getGrantHolders).not.toHaveBeenCalled();
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      kind: 'channel.data_deleted',
      data: { revoke: 'revoke_off' },
    });
  });

  it('with only a REVOKE value other than "true": no platform call', async () => {
    for (const value of ['TRUE', '1', 'false', '']) {
      process.env.YSOCIAL_DELETION_REVOKE = value;
      const { service } = setup();
      expect((await service.deleteChannelData('int-1', NOW)).result?.revoke).toBe(
        'revoke_off'
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with the REVOKE switch: refreshes and revokes at TikTok, clears the tokens, emits the event', async () => {
    revokeOn();
    const { service, repository } = setup();
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'revoked', mode: 'on' });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://open.tiktokapis.com/v2/oauth/token/',
      'https://open.tiktokapis.com/v2/oauth/revoke/',
    ]);
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      kind: 'channel.data_deleted',
      subject: { type: 'channel', id: 'int-1' },
      data: { revoke: 'revoked', overdue: true },
    });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(event)).not.toContain(REFRESH);
  });

  it('does not revoke with a holder (shared_grant) but still clears and emits', async () => {
    revokeOn();
    const { service, repository } = setup({
      holders: [[{ id: 'other', rootInternalId: 'user-1' }]],
    });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'shared_grant' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event).toBeDefined();
  });

  it('does not revoke when it is unclear who shares it (grant_unknown)', async () => {
    revokeOn();
    for (const setupOptions of [
      { row: channel({ rootInternalId: null }) },
      { holders: [[{ id: 'other', rootInternalId: null as string | null }]] },
    ]) {
      const { service, repository } = setup(setupOptions);
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'grant_unknown' });
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
      expect(event).toBeDefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the tokens without a call for a provider without revoker (not_supported)', async () => {
    revokeOn();
    for (const provider of ['facebook', 'instagram', 'youtube', 'gmb', 'linkedin-page']) {
      const { service, repository } = setup({
        row: channel({ providerIdentifier: provider }),
      });
      const { result } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'not_supported' });
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is final without a refresh token (no_refresh_token), no call', async () => {
    revokeOn();
    const { service, repository } = setup({ row: channel({ refreshToken: null }) });
    const { result } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'no_refresh_token' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
  });

  it('never calls the revoke endpoint when the row changed before the revoke', async () => {
    revokeOn();
    const { service, repository, store } = setup({
      unchanged: [false],
      posts: [postWith(['m1'])],
      media: [medium('m1')],
    });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({
      status: 'skipped',
      revoke: 'changed_meanwhile',
      media: { deleted: 0, kept: 0, failed: 0, left: 0 },
    });
    expect(event).toBeUndefined();
    expect(calls('/oauth/revoke/')).toHaveLength(0);
    expect(repository.clearTokens).not.toHaveBeenCalled();
    expect(store.removeFile).not.toHaveBeenCalled();
    expect(repository.deleteMedia).not.toHaveBeenCalled();
  });

  it('skips without any call when the row changed (REVOKE off)', async () => {
    const { service, repository, store } = setup({
      unchanged: [false],
      posts: [postWith(['m1'])],
      media: [medium('m1')],
    });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'skipped', revoke: 'revoke_off' });
    expect(event).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.clearTokens).not.toHaveBeenCalled();
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  it('does not revoke when a holder shows up only at the second check', async () => {
    revokeOn();
    const { service, repository } = setup({
      holders: [[], [{ id: 'new', rootInternalId: 'user-1' }]],
    });
    const { result } = await service.deleteChannelData('int-1', NOW);
    expect(repository.getGrantHolders).toHaveBeenCalledTimes(2);
    expect(calls('/oauth/revoke/')).toHaveLength(0);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'shared_grant' });
  });

  it('does not revoke when the second check finds a holder without rootInternalId', async () => {
    revokeOn();
    const { service } = setup({
      holders: [[], [{ id: 'new', rootInternalId: null }]],
    });
    const { result } = await service.deleteChannelData('int-1', NOW);
    expect(calls('/oauth/revoke/')).toHaveLength(0);
    expect(result?.revoke).toBe('grant_unknown');
  });

  it('warns when the account was changed right after a revoke, then skips', async () => {
    revokeOn();
    // 1: before the revoke, 2: after it, 3: before the media.
    const { service, repository } = setup({ unchanged: [true, false, false] });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(lines.some((l) => l.includes('connected meanwhile'))).toBe(true);
    expect(result).toMatchObject({ status: 'skipped', revoke: 'revoked' });
    expect(event).toBeUndefined();
    expect(repository.clearTokens).not.toHaveBeenCalled();
  });

  it('warns when a holder appears right after a revoke', async () => {
    revokeOn();
    const { service } = setup({
      holders: [[], [], [{ id: 'new', rootInternalId: 'user-1' }]],
    });
    const { result } = await service.deleteChannelData('int-1', NOW);
    expect(lines.some((l) => l.includes('connected meanwhile'))).toBe(true);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'revoked' });
  });

  it('only warns when the check after the revoke fails, the result stays revoked', async () => {
    revokeOn();
    // 1: before the revoke, 2: the check after it throws, 3: before the media.
    const { service, repository } = setup();
    repository.isUnchanged
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error(`db down ${TOKEN}`))
      .mockResolvedValue(true);
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'revoked' });
    expect(event?.data).toMatchObject({ revoke: 'revoked' });
    expect(lines).toContain(
      'channel deletion channel=int-1 revoked, check afterwards failed: Error'
    );
  });

  it('only warns when planRevoke fails in the check after the revoke', async () => {
    revokeOn();
    const { service, repository } = setup();
    repository.getGrantHolders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('db down'));
    const { result } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'revoked' });
    expect(lines.some((l) => l.includes('check afterwards failed'))).toBe(true);
  });

  it('does not warn when nothing changed', async () => {
    revokeOn();
    const { service } = setup();
    await service.deleteChannelData('int-1', NOW);
    expect(lines.some((l) => l.includes('connected meanwhile'))).toBe(false);
  });

  it('retries on a failed revoke before the deadline: no clear, no event', async () => {
    revokeOn();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/oauth/token/')
        ? reply(200, { access_token: 'test-access-token-2', open_id: 'open-id-1' })
        : reply(500)
    );
    const { service, repository } = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
    });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'retry', revoke: 'failed', overdue: false });
    expect(event).toBeUndefined();
    expect(repository.clearTokens).not.toHaveBeenCalled();
  });

  it('clears and emits with overdue true when the revoke failed past the deadline', async () => {
    revokeOn();
    fetchMock.mockResolvedValue(reply(500));
    const { service, repository } = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 7 * DAY) }),
    });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result).toMatchObject({ status: 'deleted', revoke: 'failed', overdue: true });
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event?.data).toMatchObject({ revoke: 'failed', overdue: true });
  });

  it('the deadline is 7 days minus 2 hours', async () => {
    revokeOn();
    fetchMock.mockResolvedValue(reply(500));
    const HOUR = 60 * 60_000;
    const before = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - (7 * DAY - 2 * HOUR) + 1) }),
    });
    expect((await before.service.deleteChannelData('int-1', NOW)).result?.status).toBe(
      'retry'
    );
    const at = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - (7 * DAY - 2 * HOUR)) }),
    });
    expect((await at.service.deleteChannelData('int-1', NOW)).result?.status).toBe(
      'deleted'
    );
  });

  it('retries when TikTok is not configured, then clears after the deadline', async () => {
    revokeOn();
    delete process.env.TIKTOK_CLIENT_ID;
    const young = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
    });
    expect(
      (await young.service.deleteChannelData('int-1', NOW)).result
    ).toMatchObject({ status: 'retry', revoke: 'not_configured' });
    expect(young.repository.clearTokens).not.toHaveBeenCalled();
    const old = setup();
    expect((await old.service.deleteChannelData('int-1', NOW)).result).toMatchObject({
      status: 'deleted',
      revoke: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is skipped without an event when clearTokens writes nothing', async () => {
    const { service } = setup({ cleared: 0 });
    const { result, event } = await service.deleteChannelData('int-1', NOW);
    expect(result?.status).toBe('skipped');
    expect(event).toBeUndefined();
  });

  it('treats already_invalid (invalid_grant at the refresh) as final, no revoke call', async () => {
    revokeOn();
    fetchMock.mockResolvedValue(reply(400, { error: 'invalid_grant' }));
    const { service } = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
    });
    expect((await service.deleteChannelData('int-1', NOW)).result).toMatchObject({
      status: 'deleted',
      revoke: 'already_invalid',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives the repository the channel without tokens for the writes', async () => {
    const row = channel();
    const { service, repository } = setup({ row });
    await service.deleteChannelData('int-1', NOW);
    for (const mock of [repository.clearTokens, repository.isUnchanged]) {
      const arg = mock.mock.calls[0][0] as any;
      expect(arg).toMatchObject({ id: 'int-1', deletedAt: row.deletedAt, updatedAt: row.updatedAt });
      expect(arg).not.toHaveProperty('token');
      expect(arg).not.toHaveProperty('refreshToken');
    }
  });

  describe('unreadable token', () => {
    it('with the REVOKE switch: no revoke call, retry before the deadline', async () => {
      revokeOn();
      const { service, repository } = setup({
        row: unreadable({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      });
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'retry', revoke: 'failed' });
      expect(event).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(repository.clearTokens).not.toHaveBeenCalled();
    });

    it('with the REVOKE switch: clears at the deadline, event with revoke failed', async () => {
      revokeOn();
      const { service, repository } = setup({ row: unreadable() });
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'failed', overdue: true });
      expect(event?.data).toMatchObject({ revoke: 'failed' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    });

    it('without the REVOKE switch it is cleared like any other row', async () => {
      const { service, repository } = setup({
        row: unreadable({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      });
      const { result } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'revoke_off' });
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('errors of the job', () => {
    const young = () => channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) });

    it('throws an error of planRevoke on before the deadline', async () => {
      revokeOn();
      const { service, repository } = setup({ row: young() });
      repository.getGrantHolders.mockRejectedValue(new Error('db down'));
      await expect(service.deleteChannelData('int-1', NOW)).rejects.toThrow('db down');
      expect(repository.clearTokens).not.toHaveBeenCalled();
    });

    it('clears after the deadline when planRevoke fails: warning, event with revoke failed', async () => {
      revokeOn();
      const { service, repository } = setup();
      repository.getGrantHolders.mockRejectedValue(new Error(`db down ${TOKEN}`));
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'failed', overdue: true });
      expect(event?.data).toMatchObject({ revoke: 'failed', overdue: true });
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
      expect(lines).toContain('channel deletion channel=int-1 failed: Error');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws an error of isUnchanged on before the deadline', async () => {
      const { service, repository } = setup({ row: young() });
      repository.isUnchanged.mockRejectedValue(new Error('db down'));
      await expect(service.deleteChannelData('int-1', NOW)).rejects.toThrow('db down');
      expect(repository.clearTokens).not.toHaveBeenCalled();
    });

    it('clears after the deadline when isUnchanged fails', async () => {
      const { service, repository } = setup();
      repository.isUnchanged.mockRejectedValue(new Error('db down'));
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'revoke_off' });
      expect(event).toBeDefined();
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('failed: Error'))).toBe(true);
    });

    it('throws an error of getPostMedia / getMedia on before the deadline', async () => {
      for (const method of ['getPostMedia', 'getMedia'] as const) {
        const { service, repository } = setup({
          row: young(),
          posts: [postWith(['m1'])],
          media: [medium('m1')],
        });
        repository[method].mockRejectedValue(new Error('db down'));
        await expect(service.deleteChannelData('int-1', NOW)).rejects.toThrow(
          'db down'
        );
        expect(repository.clearTokens).not.toHaveBeenCalled();
      }
    });

    it('keeps the revoke result reached so far when the media step fails after the deadline', async () => {
      revokeOn();
      const { service, repository } = setup({
        posts: [postWith(['m1'])],
        media: [medium('m1')],
      });
      repository.getPostMedia.mockRejectedValue(new Error('db down'));
      const { result, event } = await service.deleteChannelData('int-1', NOW);
      expect(result).toMatchObject({ status: 'deleted', revoke: 'revoked' });
      expect(event?.data).toMatchObject({ revoke: 'revoked' });
      expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    });

    it('reports the media counted so far when it fails halfway after the deadline', async () => {
      const built = setup({
        posts: [postWith(['m1', 'm2'])],
        media: [medium('m1'), medium('m2')],
      });
      built.repository.mediaInUse.mockImplementation(async (item: any) => {
        if (item.id === 'm2') {
          throw new Error('db down');
        }
        return false;
      });
      const { result, event } = await built.service.deleteChannelData('int-1', NOW);
      expect(result?.media).toEqual({ deleted: 1, kept: 0, failed: 0, left: 0 });
      expect(event?.data).toMatchObject({ mediaDeleted: 1, mediaKept: 0, mediaFailed: 0 });
      expect(built.repository.clearTokens).toHaveBeenCalledTimes(1);
    });

    it('a failing clearTokens still throws', async () => {
      const { service, repository } = setup();
      repository.clearTokens.mockRejectedValue(new Error('db down'));
      await expect(service.deleteChannelData('int-1', NOW)).rejects.toThrow('db down');
    });
  });
});

describe('deleteChannelData: media', () => {
  beforeEach(on);

  const run = (options: Parameters<typeof setup>[0], now = NOW) => {
    const built = setup(options);
    return { ...built, done: built.service.deleteChannelData('int-1', now) };
  };

  it('deletes a free medium: path and thumbnail first, then the row', async () => {
    const m = medium('m1', { thumbnail: `${UPLOADS}/m1-thumb.png` });
    const { done, store, repository } = run({
      posts: [postWith(['m1'])],
      media: [m],
    });
    const { result } = await done;
    expect(result?.media).toEqual({ deleted: 1, kept: 0, failed: 0, left: 0 });
    expect(store.removeFile.mock.calls.map((c) => c[0])).toEqual([
      `${UPLOADS}/m1.png`,
      `${UPLOADS}/m1-thumb.png`,
    ]);
    expect(repository.deleteMedia).toHaveBeenCalledWith('m1', 'org-1');
    expect(store.removeFile.mock.invocationCallOrder[1]).toBeLessThan(
      repository.deleteMedia.mock.invocationCallOrder[0]
    );
    expect(repository.getMedia).toHaveBeenCalledWith(
      'org-1',
      ['m1'],
      [`${UPLOADS}/m1.png`]
    );
  });

  it('does nothing about media when the posts name none', async () => {
    const { done, repository, store } = run({
      posts: [{ image: null, settings: 'broken' }],
    });
    expect((await done).result?.media).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
      left: 0,
    });
    expect(repository.getMedia).not.toHaveBeenCalled();
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  const keeps: Array<[string, any, (item: any) => boolean]> = [
    ['mediaInUse true', medium('m1'), () => true],
    [
      'used as user picture',
      medium('m1', { _count: { userPicture: 1, agencies: 0, oauthApps: 0 } }),
      () => false,
    ],
    [
      'used as agency logo',
      medium('m1', { _count: { userPicture: 0, agencies: 2, oauthApps: 0 } }),
      () => false,
    ],
    [
      'used by an OAuth app',
      medium('m1', { _count: { userPicture: 0, agencies: 0, oauthApps: 1 } }),
      () => false,
    ],
    [
      'path outside our storage',
      medium('m1', { path: 'https://other.test/uploads/m1.png' }),
      () => false,
    ],
    [
      'path with ..',
      medium('m1', { path: `${UPLOADS}/../secret.png` }),
      () => false,
    ],
    [
      'foreign thumbnail',
      medium('m1', { thumbnail: 'https://other.test/t.png' }),
      () => false,
    ],
  ];
  for (const [name, item, inUse] of keeps) {
    it(`keeps a medium: ${name}`, async () => {
      const { done, store, repository } = run({
        posts: [postWith(['m1'])],
        media: [item],
        inUse,
      });
      const { result } = await done;
      expect(result?.media).toEqual({ deleted: 0, kept: 1, failed: 0, left: 0 });
      expect(store.removeFile).not.toHaveBeenCalled();
      expect(repository.deleteMedia).not.toHaveBeenCalled();
      // A kept medium does not hold back the deletion.
      expect(result?.status).toBe('deleted');
    });
  }

  it('keeps every medium when the storage prefix is unknown (fail-closed)', async () => {
    delete process.env.FRONTEND_URL;
    const { done, store, repository } = run({
      posts: [postWith(['m1'])],
      media: [medium('m1')],
    });
    expect((await done).result?.media.kept).toBe(1);
    expect(store.removeFile).not.toHaveBeenCalled();
    expect(repository.deleteMedia).not.toHaveBeenCalled();
  });

  it('uses the cloudflare bucket prefix', async () => {
    process.env.STORAGE_PROVIDER = 'cloudflare';
    process.env.CLOUDFLARE_BUCKET_URL = 'https://cdn.test';
    const { done, store } = run({
      posts: [postWith(['m1', 'm2'])],
      media: [
        medium('m1', { path: 'https://cdn.test/m1.png' }),
        medium('m2'),
      ],
    });
    const { result } = await done;
    expect(result?.media).toMatchObject({ deleted: 1, kept: 1 });
    expect(store.removeFile).toHaveBeenCalledWith('https://cdn.test/m1.png');
  });

  it('counts ENOENT as removed and goes on', async () => {
    const { done, repository } = run({
      posts: [postWith(['m1'])],
      media: [medium('m1', { thumbnail: `${UPLOADS}/t.png` })],
      removeFile: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
    });
    const { result } = await done;
    expect(result?.media).toEqual({ deleted: 1, kept: 0, failed: 0, left: 0 });
    expect(repository.deleteMedia).toHaveBeenCalledTimes(1);
  });

  it('counts another error as failed, keeps the row and retries', async () => {
    const { done, repository } = run({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      posts: [postWith(['m1', 'm2'])],
      media: [medium('m1'), medium('m2')],
      removeFile: async (path) => {
        if (path.endsWith('m1.png')) {
          throw Object.assign(new Error(`EACCES ${TOKEN}`), { code: 'EACCES' });
        }
      },
    });
    const { result, event } = await done;
    expect(result?.media).toEqual({ deleted: 1, kept: 0, failed: 1, left: 0 });
    expect(result?.status).toBe('retry');
    expect(event).toBeUndefined();
    expect(repository.deleteMedia).toHaveBeenCalledTimes(1);
    expect(repository.deleteMedia).toHaveBeenCalledWith('m2', 'org-1');
    expect(repository.clearTokens).not.toHaveBeenCalled();
  });

  it('counts a failing deleteMedia as failed', async () => {
    const built = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      posts: [postWith(['m1'])],
      media: [medium('m1')],
    });
    built.repository.deleteMedia.mockRejectedValue(new Error('db down'));
    const { result } = await built.service.deleteChannelData('int-1', NOW);
    expect(result?.media.failed).toBe(1);
    expect(result?.status).toBe('retry');
  });

  it('clears the tokens past the deadline although media failed, and says so', async () => {
    const { done, repository } = run({
      posts: [postWith(['m1'])],
      media: [medium('m1')],
      removeFile: async () => {
        throw Object.assign(new Error('x'), { code: 'EIO' });
      },
    });
    const { result, event } = await done;
    expect(result).toMatchObject({ status: 'deleted', overdue: true });
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event?.data).toMatchObject({ mediaFailed: 1, overdue: true });
  });

  it('has no upper limit: 205 media are all checked within the budget', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `m${i}`);
    const { done, store, repository } = run({
      posts: [postWith(ids)],
      media: ids.map((id) => medium(id)),
    });
    const { result } = await done;
    expect(result?.media).toEqual({ deleted: 205, kept: 0, failed: 0, left: 0 });
    expect(store.removeFile).toHaveBeenCalledTimes(205);
    expect(repository.deleteMedia).toHaveBeenCalledTimes(205);
  });

  // The clock is read once at the start and once before every medium.
  const budgetClock = (afterChecks: number) => {
    let reads = 0;
    return () => (++reads > afterChecks + 1 ? DELETION_MEDIA_BUDGET_MS + 1 : 0);
  };

  it('stops at the time budget, counts the rest as left and retries before the deadline', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const { done, store, repository } = run({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      posts: [postWith(ids)],
      media: ids.map((id) => medium(id)),
      clock: budgetClock(2),
    });
    const { result, event } = await done;
    expect(result?.media).toEqual({ deleted: 2, kept: 0, failed: 0, left: 3 });
    expect(result?.status).toBe('retry');
    expect(event).toBeUndefined();
    expect(store.removeFile).toHaveBeenCalledTimes(2);
    expect(repository.deleteMedia).toHaveBeenCalledTimes(2);
    expect(repository.clearTokens).not.toHaveBeenCalled();
  });

  it('exactly at the budget still works, one millisecond over stops', async () => {
    const ids = ['m1', 'm2'];
    for (const [elapsed, left] of [
      [DELETION_MEDIA_BUDGET_MS, 0],
      [DELETION_MEDIA_BUDGET_MS + 1, 2],
    ]) {
      let reads = 0;
      const { done } = run({
        posts: [postWith(ids)],
        media: ids.map((id) => medium(id)),
        clock: () => (reads++ === 0 ? 0 : elapsed),
      });
      expect((await done).result?.media.left).toBe(left);
    }
  });

  it('clears the tokens past the deadline although media are left, and says so', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const { done, repository } = run({
      posts: [postWith(ids)],
      media: ids.map((id) => medium(id)),
      clock: budgetClock(1),
    });
    const { result, event } = await done;
    expect(result).toMatchObject({
      status: 'deleted',
      overdue: true,
      media: { deleted: 1, left: 2 },
    });
    expect(repository.clearTokens).toHaveBeenCalledTimes(1);
    expect(event?.data).toMatchObject({ mediaDeleted: 1, mediaLeft: 2, overdue: true });
    expect(event?.reason).toContain('2 nicht gelöscht');
  });

  it('does not use the clock in a dry run to delete, but still counts left', async () => {
    delete process.env.YSOCIAL_DELETION_ENABLED;
    const ids = ['m1', 'm2', 'm3'];
    const { done, store } = run({
      posts: [postWith(ids)],
      media: ids.map((id) => medium(id)),
      clock: budgetClock(1),
    });
    const { result } = await done;
    expect(result?.media).toEqual({ deleted: 1, kept: 0, failed: 0, left: 2 });
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  it('deletes no media when the row changed (skipped)', async () => {
    const { done, store } = run({
      unchanged: [false],
      posts: [postWith(['m1'])],
      media: [medium('m1')],
    });
    // the check before the media fails
    expect((await done).result?.status).toBe('skipped');
    expect(store.removeFile).not.toHaveBeenCalled();
  });
});

describe('logs', () => {
  it('never hold a token, also on errors and failures', async () => {
    on();
    fetchMock.mockRejectedValue(new Error(`network ${TOKEN} ${REFRESH}`));
    const { service } = setup({
      row: channel({ deletedAt: new Date(NOW.getTime() - 6.5 * DAY) }),
      posts: [postWith(['m1'])],
      media: [medium('m1')],
      removeFile: async () => {
        throw new Error(`disk ${TOKEN}`);
      },
    });
    await service.deleteChannelData('int-1', NOW);
    await service.findDue(NOW);
    expect(lines.length).toBeGreaterThan(0);
    // checked in afterEach for every line
  });
});
