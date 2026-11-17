import {
  WEBHOOK_CHANNEL_FIELDS,
  YsocialWebhookRepository,
} from './ysocial.webhook.repository';

const setup = (rows: unknown[] = [{ id: 'int-1' }]) => {
  const integration = { findMany: jest.fn().mockResolvedValue(rows) };
  const repository = new YsocialWebhookRepository({
    model: { integration },
  } as any);
  return { repository, integration };
};

describe('YsocialWebhookRepository.getChannelsForWebhook', () => {
  it('reads the channels of one Page with a fixed select, without deleted or disabled ones', async () => {
    const { repository, integration } = setup();
    const result = await repository.getChannelsForWebhook(
      'facebook',
      '100000000000001'
    );
    expect(result).toEqual([{ id: 'int-1' }]);
    expect(integration.findMany).toHaveBeenCalledTimes(1);
    const args = integration.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      providerIdentifier: 'facebook',
      internalId: '100000000000001',
      deletedAt: null,
      disabled: false,
    });
    expect(args.select).toBe(WEBHOOK_CHANNEL_FIELDS);
    expect(args.take).toBe(20);
  });

  it('asks for the Instagram provider and account when told so', async () => {
    const { repository, integration } = setup();
    await repository.getChannelsForWebhook('instagram', '17840000000000001');
    expect(integration.findMany.mock.calls[0][0].where).toMatchObject({
      providerIdentifier: 'instagram',
      internalId: '17840000000000001',
      deletedAt: null,
      disabled: false,
    });
  });

  it('selects exactly the ids the bell needs, no token or other credential', () => {
    expect(WEBHOOK_CHANNEL_FIELDS).toEqual({
      id: true,
      organizationId: true,
      customerId: true,
      providerIdentifier: true,
    });
    expect(Object.keys(WEBHOOK_CHANNEL_FIELDS).sort()).toEqual(
      ['customerId', 'id', 'organizationId', 'providerIdentifier'].sort()
    );
  });

  it('does not filter by organization, so the channels of every organization come back', async () => {
    const { repository, integration } = setup();
    await repository.getChannelsForWebhook('facebook', '1');
    expect(integration.findMany.mock.calls[0][0].where).not.toHaveProperty(
      'organizationId'
    );
  });

  it('has no write method', () => {
    const methods = Object.getOwnPropertyNames(
      YsocialWebhookRepository.prototype
    ).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['getChannelsForWebhook']);
  });

  it('touches only findMany of the integration model', async () => {
    const { integration } = setup();
    const guarded = new Proxy(integration, {
      get(target, prop) {
        if (prop !== 'findMany') {
          throw new Error(`integration.${String(prop)} must not be used`);
        }
        return target[prop as 'findMany'];
      },
    });
    const strict = new YsocialWebhookRepository({
      model: { integration: guarded },
    } as any);
    await expect(
      strict.getChannelsForWebhook('facebook', '1')
    ).resolves.toEqual([{ id: 'int-1' }]);
  });

  it('passes an error of the database on', async () => {
    const { repository, integration } = setup();
    integration.findMany.mockRejectedValue(new Error('db down'));
    await expect(
      repository.getChannelsForWebhook('facebook', '1')
    ).rejects.toThrow('db down');
  });
});
