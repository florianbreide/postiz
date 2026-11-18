import {
  MEDIA_FIELDS,
  POST_FIELDS,
  POST_QUERY_FIELDS,
  POSTS_LIMIT,
  READ_API_FORBIDDEN_FIELDS,
  YsocialReadRepository,
} from './ysocial.read.repository';

const setup = () => {
  const post = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  };
  const media = {
    findMany: jest.fn().mockResolvedValue([]),
  };
  const repository = new YsocialReadRepository(
    {} as any,
    {} as any,
    { model: { post } } as any,
    { model: { media } } as any
  );
  return { repository, post, media };
};

describe('YsocialReadRepository posts', () => {
  it('getPost reads one post by id, never a deleted one, with POST_QUERY_FIELDS', async () => {
    const { repository, post } = setup();
    await repository.getPost('post-1');
    expect(post.findFirst).toHaveBeenCalledTimes(1);
    expect(post.findFirst.mock.calls[0][0]).toEqual({
      where: { id: 'post-1', deletedAt: null },
      select: POST_QUERY_FIELDS,
    });
  });

  it('getPostGroup is limited to the organization and the group, without deleted posts, oldest first', async () => {
    const { repository, post } = setup();
    await repository.getPostGroup('org-1', 'g-1');
    expect(post.findMany).toHaveBeenCalledTimes(1);
    const args = post.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      organizationId: 'org-1',
      group: 'g-1',
      deletedAt: null,
    });
    expect(args.select).toBe(POST_QUERY_FIELDS);
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('getPosts keeps the date range, the deleted filter, the order and the limit', async () => {
    const { repository, post } = setup();
    const from = new Date('2026-10-27T00:00:00Z');
    const to = new Date('2026-10-28T00:00:00Z');
    await repository.getPosts(from, to);
    expect(post.findMany.mock.calls[0][0]).toEqual({
      where: { deletedAt: null, publishDate: { gte: from, lt: to } },
      select: POST_QUERY_FIELDS,
      orderBy: { publishDate: 'asc' },
      take: POSTS_LIMIT,
    });
  });

  it('selects text and media but no field of READ_API_FORBIDDEN_FIELDS', () => {
    expect(Object.keys(POST_FIELDS)).toEqual(
      expect.arrayContaining(['content', 'image'])
    );
    for (const field of READ_API_FORBIDDEN_FIELDS) {
      expect(Object.keys(POST_FIELDS)).not.toContain(field);
    }
  });

  it('POST_QUERY_FIELDS is POST_FIELDS plus exactly settings', () => {
    expect({ ...POST_QUERY_FIELDS }).toEqual({
      ...POST_FIELDS,
      settings: true,
    });
    expect(Object.keys(POST_QUERY_FIELDS)).toEqual([
      ...Object.keys(POST_FIELDS),
      'settings',
    ]);
    expect(READ_API_FORBIDDEN_FIELDS).toContain('settings');
    expect(Object.keys(POST_FIELDS)).not.toContain('settings');
  });

  it('all three post queries select settings, none of them a second forbidden field', async () => {
    const { repository, post } = setup();
    await repository.getPost('post-1');
    await repository.getPostGroup('org-1', 'g-1');
    await repository.getPosts(new Date(0), new Date(1));
    const selects = [
      post.findFirst.mock.calls[0][0].select,
      ...post.findMany.mock.calls.map((call) => call[0].select),
    ];
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      expect(select).toBe(POST_QUERY_FIELDS);
      expect(
        Object.keys(select).filter((field) =>
          READ_API_FORBIDDEN_FIELDS.includes(field as any)
        )
      ).toEqual(['settings']);
    }
  });
});

describe('YsocialReadRepository media (K6)', () => {
  it('MEDIA_FIELDS is exactly id, organizationId, path and fileSize', () => {
    expect(Object.keys(MEDIA_FIELDS)).toEqual([
      'id',
      'organizationId',
      'path',
      'fileSize',
    ]);
    expect(Object.values(MEDIA_FIELDS).every((value) => value === true)).toBe(
      true
    );
    for (const field of READ_API_FORBIDDEN_FIELDS) {
      expect(Object.keys(MEDIA_FIELDS)).not.toContain(field);
    }
  });

  it('getMedia reads the ids in one findMany, also deleted rows, with MEDIA_FIELDS', async () => {
    const { repository, media } = setup();
    await repository.getMedia(['media-1', 'media-2']);
    expect(media.findMany).toHaveBeenCalledTimes(1);
    const args = media.findMany.mock.calls[0][0];
    expect(args).toEqual({
      where: { id: { in: ['media-1', 'media-2'] } },
      select: MEDIA_FIELDS,
    });
    expect(args.where).not.toHaveProperty('deletedAt');
  });

  it('getMedia returns what the model returns', async () => {
    const { repository, media } = setup();
    const rows = [{ id: 'media-1' }];
    media.findMany.mockResolvedValueOnce(rows);
    expect(await repository.getMedia(['media-1'])).toBe(rows);
  });
});
