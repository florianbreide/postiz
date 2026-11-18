import { Logger } from '@nestjs/common';
import { YsocialAutomationCheck } from './ysocial.automation.check';
import { YsocialAutomationRepository } from '../database/ysocial.automation.repository';

const repository = {
  countRepeatingPosts: jest.fn(),
  getPlugSettings: jest.fn(),
  countActiveGlobalPlugs: jest.fn(),
};
const check = () => new YsocialAutomationCheck(repository as any);

const PLUG = JSON.stringify({ 'plug--like--integrations': ['c1'] });
const SECRET = 'Erfundener Posttext, der nie im Log stehen darf';

describe('YsocialAutomationCheck', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    repository.countRepeatingPosts.mockResolvedValue(0);
    repository.getPlugSettings.mockResolvedValue([]);
    repository.countActiveGlobalPlugs.mockResolvedValue(0);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('counts repeats, internal plugs and global plugs', async () => {
    repository.countRepeatingPosts.mockResolvedValue(2);
    repository.getPlugSettings.mockResolvedValue([
      { settings: PLUG },
      { settings: JSON.stringify({ 'plug--like--integrations': [] }) },
      { settings: PLUG },
    ]);
    repository.countActiveGlobalPlugs.mockResolvedValue(4);
    expect(await check().count()).toEqual({
      repeats: 2,
      plugs: 2,
      globalPlugs: 4,
    });
  });

  it('does not count unreadable or empty settings', async () => {
    repository.getPlugSettings.mockResolvedValue([
      { settings: '{not json' },
      { settings: '' },
      { settings: null },
      { settings: '[]' },
      { settings: '"plug-"' },
    ]);
    expect((await check().count()).plugs).toBe(0);
  });

  it('logs plain with zero found', async () => {
    await check().onApplicationBootstrap();
    expect(log).toHaveBeenCalledWith(
      'automation check repeats=0 plugs=0 globalPlugs=0'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with numbers when something is found', async () => {
    repository.countRepeatingPosts.mockResolvedValue(1);
    repository.getPlugSettings.mockResolvedValue([{ settings: PLUG }]);
    repository.countActiveGlobalPlugs.mockResolvedValue(3);
    await check().onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      'automation check repeats=1 plugs=1 globalPlugs=3'
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('never writes settings into the log', async () => {
    repository.getPlugSettings.mockResolvedValue([
      {
        settings: JSON.stringify({
          text: SECRET,
          'plug--a--integrations': ['c'],
        }),
      },
    ]);
    await check().onApplicationBootstrap();
    const all = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('plug--a');
  });

  it('logs the error class and does not throw when the repository fails', async () => {
    repository.countRepeatingPosts.mockRejectedValue(
      new TypeError(`secret ${SECRET}`)
    );
    await expect(check().onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'automation check failed error=TypeError'
    );
  });

  it('logs Error for a thrown non-error', async () => {
    repository.getPlugSettings.mockRejectedValue('boom');
    await expect(check().onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('automation check failed error=Error');
  });
});

describe('YsocialAutomationRepository', () => {
  const postModel = { count: jest.fn(), findMany: jest.fn() };
  const plugsModel = { count: jest.fn() };
  const repo = new YsocialAutomationRepository(
    { model: { post: postModel } } as any,
    { model: { plugs: plugsModel } } as any
  );

  beforeEach(() => jest.clearAllMocks());

  it('counts posts with an interval above 0 that are not deleted', async () => {
    postModel.count.mockResolvedValue(3);
    expect(await repo.countRepeatingPosts()).toBe(3);
    expect(postModel.count).toHaveBeenCalledWith({
      where: { deletedAt: null, parentPostId: null, intervalInDays: { gt: 0 } },
    });
  });

  it('selects only settings of the plug candidates', async () => {
    postModel.findMany.mockResolvedValue([]);
    await repo.getPlugSettings();
    expect(postModel.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        parentPostId: null,
        settings: { contains: 'plug-' },
      },
      select: { settings: true },
    });
  });

  it('counts active plugs of channels that are not deleted', async () => {
    plugsModel.count.mockResolvedValue(5);
    expect(await repo.countActiveGlobalPlugs()).toBe(5);
    expect(plugsModel.count).toHaveBeenCalledWith({
      where: { activated: true, integration: { deletedAt: null } },
    });
  });
});
