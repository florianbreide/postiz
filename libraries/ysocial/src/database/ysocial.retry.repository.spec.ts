import {
  RETRY_POST_FIELDS,
  YsocialRetryRepository,
} from './ysocial.retry.repository';
import { READ_API_FORBIDDEN_FIELDS } from './ysocial.read.repository';

const setup = () => {
  const post = {
    findUnique: jest.fn().mockResolvedValue({ id: 'post-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const repository = new YsocialRetryRepository({
    model: { post },
  } as any);
  return { repository, post };
};

describe('YsocialRetryRepository.getPostForRetry', () => {
  it('reads one post by id with a fixed select', async () => {
    const { repository, post } = setup();
    await repository.getPostForRetry('post-1');
    expect(post.findUnique).toHaveBeenCalledTimes(1);
    const args = post.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'post-1' });
    expect(args.select).toBe(RETRY_POST_FIELDS);
  });

  it('selects every field retry.rules.ts decides on', () => {
    expect(Object.keys(RETRY_POST_FIELDS).sort()).toEqual(
      [
        'deletedAt',
        'error',
        'id',
        'integration',
        'organizationId',
        'parentPostId',
        'releaseId',
        'releaseURL',
        'state',
      ].sort()
    );
    expect(Object.keys(RETRY_POST_FIELDS.integration.select).sort()).toEqual(
      [
        'deletedAt',
        'disabled',
        'inBetweenSteps',
        'providerIdentifier',
        'refreshNeeded',
      ].sort()
    );
  });

  it('selects no field of READ_API_FORBIDDEN_FIELDS, also not in the channel', async () => {
    const { repository, post } = setup();
    await repository.getPostForRetry('post-1');
    const { select } = post.findUnique.mock.calls[0][0];
    for (const field of READ_API_FORBIDDEN_FIELDS) {
      expect(Object.keys(select)).not.toContain(field);
      expect(Object.keys(select.integration.select)).not.toContain(field);
    }
  });
});

describe('YsocialRetryRepository.queueFailedPost', () => {
  it('moves ERROR to QUEUE only for a post that is still in ERROR', async () => {
    const { repository, post } = setup();
    await repository.queueFailedPost('post-1');
    expect(post.updateMany).toHaveBeenCalledWith({
      where: { id: 'post-1', state: 'ERROR', deletedAt: null },
      data: { state: 'QUEUE' },
    });
  });

  it('returns true only when exactly one row changed', async () => {
    const { repository, post } = setup();
    post.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await repository.queueFailedPost('post-1')).toBe(true);
    post.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repository.queueFailedPost('post-1')).toBe(false);
    post.updateMany.mockResolvedValueOnce({ count: 2 });
    expect(await repository.queueFailedPost('post-1')).toBe(false);
  });
});
