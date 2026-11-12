import {
  INBOX_CHANNEL_FIELDS,
  YsocialInboxRepository,
} from './ysocial.inbox.repository';

const setup = () => {
  const integration = {
    findUnique: jest.fn().mockResolvedValue({ id: 'int-demo-1' }),
  };
  const repository = new YsocialInboxRepository({
    model: { integration },
  } as any);
  return { repository, integration };
};

describe('YsocialInboxRepository.getChannelForInbox', () => {
  it('reads one channel by id with a fixed select', async () => {
    const { repository, integration } = setup();
    await repository.getChannelForInbox('int-demo-1');
    expect(integration.findUnique).toHaveBeenCalledTimes(1);
    const args = integration.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'int-demo-1' });
    expect(args.select).toBe(INBOX_CHANNEL_FIELDS);
  });

  it('selects exactly the fields the inbox decides on', () => {
    expect(Object.keys(INBOX_CHANNEL_FIELDS).sort()).toEqual(
      [
        'deletedAt',
        'disabled',
        'id',
        'inBetweenSteps',
        'internalId',
        'providerIdentifier',
        'refreshNeeded',
        'token',
      ].sort()
    );
  });

  it('has no write method', () => {
    const methods = Object.getOwnPropertyNames(
      YsocialInboxRepository.prototype
    ).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['getChannelForInbox']);
  });

  it('touches only findUnique of the integration model', async () => {
    const { repository, integration } = setup();
    const guarded = new Proxy(integration, {
      get(target, prop) {
        if (prop !== 'findUnique') {
          throw new Error(`integration.${String(prop)} must not be used`);
        }
        return target[prop as 'findUnique'];
      },
    });
    const strict = new YsocialInboxRepository({
      model: { integration: guarded },
    } as any);
    await expect(strict.getChannelForInbox('int-demo-1')).resolves.toEqual({
      id: 'int-demo-1',
    });
  });
});
