import {
  DELETION_CHANNEL_FIELDS,
  DELETION_MEDIA_FIELDS,
  YsocialDeletionRepository,
} from './ysocial.deletion.repository';

const setup = () => {
  const integration = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue({ id: 'int-1' }),
    count: jest.fn().mockResolvedValue(1),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const post = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  };
  const media = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const sets = { findFirst: jest.fn().mockResolvedValue(null) };
  const signatures = { findFirst: jest.fn().mockResolvedValue(null) };
  const clippingClip = { findFirst: jest.fn().mockResolvedValue(null) };
  const repository = new YsocialDeletionRepository(
    { model: { integration } } as any,
    { model: { post } } as any,
    { model: { media } } as any,
    { model: { sets } } as any,
    { model: { signatures } } as any,
    { model: { clippingClip } } as any
  );
  return { repository, integration, post, media, sets, signatures, clippingClip };
};

const row = {
  id: 'int-1',
  deletedAt: new Date('2026-11-01T08:00:00.000Z'),
  updatedAt: new Date('2026-11-01T08:00:00.000Z'),
};
const item = {
  id: 'm1',
  path: 'https://app.test/uploads/m1.png',
  thumbnail: null as string | null,
};

describe('fixed field lists', () => {
  it('lists the channel fields the service needs, nothing else', () => {
    expect(Object.keys(DELETION_CHANNEL_FIELDS).sort()).toEqual(
      [
        'customerId',
        'deletedAt',
        'id',
        'internalId',
        'organizationId',
        'providerIdentifier',
        'refreshToken',
        'rootInternalId',
        'token',
        'updatedAt',
      ].sort()
    );
    expect(DELETION_MEDIA_FIELDS).toEqual({
      id: true,
      path: true,
      thumbnail: true,
      _count: { select: { userPicture: true, agencies: true, oauthApps: true } },
    });
  });

  it('reads a channel by id with the fixed select', async () => {
    const { repository, integration } = setup();
    await repository.getChannelForDeletion('int-1');
    expect(integration.findUnique).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      select: DELETION_CHANNEL_FIELDS,
    });
  });
});

describe('getDeletedChannels', () => {
  it('asks for deleted channels up to the cutoff, oldest first, with a small select', async () => {
    const { repository, integration } = setup();
    const before = new Date('2026-11-11T00:00:00.000Z');
    await repository.getDeletedChannels(before);
    const args = integration.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: { not: null, lte: before } });
    expect(args.orderBy).toEqual({ deletedAt: 'asc' });
    expect(args.select).toEqual({
      id: true,
      deletedAt: true,
      token: true,
      refreshToken: true,
    });
  });
});

describe('getGrantHolders', () => {
  it('filters other channels of the family that are connected or in grace, sharing an identity or none', async () => {
    const { repository, integration } = setup();
    const cutoff = new Date('2026-11-11T00:00:00.000Z');
    await repository.getGrantHolders({
      id: 'int-1',
      providers: ['facebook', 'instagram'],
      identities: ['user-1', 'page-1'],
      graceCutoff: cutoff,
    });
    const args = integration.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      id: { not: 'int-1' },
      providerIdentifier: { in: ['facebook', 'instagram'] },
      AND: [
        { OR: [{ deletedAt: null }, { deletedAt: { gt: cutoff } }] },
        {
          OR: [
            { rootInternalId: null },
            { rootInternalId: { in: ['user-1', 'page-1'] } },
            { internalId: { in: ['user-1', 'page-1'] } },
          ],
        },
      ],
    });
    // No organization filter: the authorization is shared across them.
    expect(JSON.stringify(args.where)).not.toContain('organizationId');
    expect(args.select).toEqual({ id: true, rootInternalId: true });
  });
});

describe('writes to the channel', () => {
  it('isUnchanged counts by id, deletedAt and updatedAt only', async () => {
    const { repository, integration } = setup();
    expect(await repository.isUnchanged(row)).toBe(true);
    expect(integration.count).toHaveBeenCalledWith({
      where: { id: 'int-1', deletedAt: row.deletedAt, updatedAt: row.updatedAt },
    });
    integration.count.mockResolvedValue(0);
    expect(await repository.isUnchanged(row)).toBe(false);
    integration.count.mockResolvedValue(2);
    expect(await repository.isUnchanged(row)).toBe(false);
  });

  it('clearTokens writes only where id, deletedAt and updatedAt still match', async () => {
    const { repository, integration } = setup();
    expect(await repository.clearTokens(row)).toBe(1);
    expect(integration.updateMany).toHaveBeenCalledTimes(1);
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: 'int-1', deletedAt: row.deletedAt, updatedAt: row.updatedAt },
      data: { token: '', refreshToken: null },
    });
    integration.updateMany.mockResolvedValue({ count: 0 });
    expect(await repository.clearTokens(row)).toBe(0);
  });

  it('never uses a bare update or delete on integrations', () => {
    const { integration } = setup();
    expect(Object.keys(integration)).not.toEqual(
      expect.arrayContaining(['update', 'delete', 'deleteMany'])
    );
  });
});

describe('media', () => {
  it('reads the posts of a channel, deleted ones included', async () => {
    const { repository, post } = setup();
    await repository.getPostMedia('int-1');
    expect(post.findMany).toHaveBeenCalledWith({
      where: { integrationId: 'int-1' },
      select: { image: true, settings: true },
    });
    expect(post.findMany.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
  });

  it('reads media of the organization only, by id or path', async () => {
    const { repository, media } = setup();
    await repository.getMedia('org-1', ['m1'], ['p1']);
    expect(media.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        OR: [{ id: { in: ['m1'] } }, { path: { in: ['p1'] } }],
      },
      select: DELETION_MEDIA_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  });

  it('deletes a medium only with id and organizationId', async () => {
    const { repository, media } = setup();
    expect(await repository.deleteMedia('m1', 'org-1')).toBe(1);
    expect(media.deleteMany).toHaveBeenCalledWith({
      where: { id: 'm1', organizationId: 'org-1' },
    });
  });
});

describe('mediaInUse', () => {
  it('is false when nothing uses it, and looks everywhere', async () => {
    const { repository, media, post, sets, signatures, clippingClip } = setup();
    expect(await repository.mediaInUse(item)).toBe(false);

    expect(media.count.mock.calls[0][0].where).toEqual({
      id: { not: 'm1' },
      OR: [{ path: item.path }, { thumbnail: item.path }],
    });
    const postWhere = post.findFirst.mock.calls[0][0].where;
    expect(postWhere.deletedAt).toBeNull();
    expect(postWhere.OR).toEqual(
      ['m1', item.path].flatMap((ref) => [
        { image: { contains: ref } },
        { settings: { contains: ref } },
        { content: { contains: ref } },
      ])
    );
    expect(sets.findFirst.mock.calls[0][0].where.OR).toEqual([
      { content: { contains: 'm1' } },
      { content: { contains: item.path } },
    ]);
    const signatureWhere = signatures.findFirst.mock.calls[0][0].where;
    expect(signatureWhere.deletedAt).toBeNull();
    expect(signatureWhere.OR).toHaveLength(2);
    expect(clippingClip.findFirst.mock.calls[0][0].where.OR).toEqual([
      { mediaId: 'm1' },
      { path: item.path },
      { thumbnail: item.path },
    ]);
  });

  it('includes the thumbnail in every lookup', async () => {
    const { repository, media, post, clippingClip } = setup();
    await repository.mediaInUse({ ...item, thumbnail: 'https://app.test/uploads/t.png' });
    expect(media.count.mock.calls[0][0].where.OR).toHaveLength(4);
    expect(post.findFirst.mock.calls[0][0].where.OR).toHaveLength(9);
    expect(clippingClip.findFirst.mock.calls[0][0].where.OR).toHaveLength(5);
  });

  const hits: Array<[string, (m: ReturnType<typeof setup>) => void]> = [
    ['another Media row with the same file', (m) => m.media.count.mockResolvedValue(1)],
    ['a post', (m) => m.post.findFirst.mockResolvedValue({ id: 'p' })],
    ['a set', (m) => m.sets.findFirst.mockResolvedValue({ id: 's' })],
    ['a signature', (m) => m.signatures.findFirst.mockResolvedValue({ id: 'g' })],
    ['a clip', (m) => m.clippingClip.findFirst.mockResolvedValue({ id: 'c' })],
  ];
  for (const [name, arrange] of hits) {
    it(`is true as soon as ${name} uses it`, async () => {
      const built = setup();
      arrange(built);
      expect(await built.repository.mediaInUse(item)).toBe(true);
    });
  }
});
