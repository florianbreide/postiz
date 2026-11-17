import {
  CancelledFailure,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';

// The Temporal workflow APIs only work inside a worker. Here they are mocked,
// the workflow function runs as a plain async function.
const mockStartChild = jest.fn();
const mockActivities = {
  ysocialFindChannelsForDeletion: jest.fn(),
  ysocialDeleteChannelData: jest.fn(),
};

jest.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: jest.requireActual('@temporalio/workflow/lib/interfaces')
    .ParentClosePolicy,
  WorkflowIdReusePolicy:
    jest.requireActual('@temporalio/common').WorkflowIdReusePolicy,
  isCancellation: (err: unknown) =>
    err instanceof jest.requireActual('@temporalio/common').CancelledFailure,
  startChild: (...args: unknown[]) => mockStartChild(...args),
  proxyActivities: () => mockActivities,
}));

import { ysocialChannelDeletionWorkflow } from './ysocial.channel.deletion.workflow';
import { createHubEvent } from '../../../../../libraries/ysocial/src/events/hub.event';

const eventFor = (id: string) =>
  createHubEvent({
    kind: 'channel.data_deleted',
    subject: { type: 'channel', id },
    stateKey: '1',
    occurredAt: new Date('2026-11-17T10:00:00.000Z'),
    reason: 'Getrennter Kanal gelöscht',
  });

const outcome = (status: string, event?: unknown) => ({
  result: { status },
  event,
});

beforeEach(() => {
  mockStartChild.mockReset().mockResolvedValue({});
  mockActivities.ysocialFindChannelsForDeletion.mockReset();
  mockActivities.ysocialDeleteChannelData.mockReset();
});

describe('ysocialChannelDeletionWorkflow', () => {
  it('finds the channels, deletes each one by id and counts the status', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 6,
      integrationIds: ['a', 'b', 'c', 'd', 'e'],
    });
    mockActivities.ysocialDeleteChannelData
      .mockResolvedValueOnce(outcome('deleted', eventFor('a')))
      .mockResolvedValueOnce(outcome('retry'))
      .mockResolvedValueOnce(outcome('skipped'))
      .mockResolvedValueOnce({ result: null })
      .mockResolvedValueOnce(outcome('deleted', eventFor('e')));

    const summary = await ysocialChannelDeletionWorkflow();

    expect(mockActivities.ysocialFindChannelsForDeletion).toHaveBeenCalledWith({});
    expect(mockActivities.ysocialDeleteChannelData.mock.calls).toEqual([
      [{ integrationId: 'a' }],
      [{ integrationId: 'b' }],
      [{ integrationId: 'c' }],
      [{ integrationId: 'd' }],
      [{ integrationId: 'e' }],
    ]);
    expect(summary).toEqual({
      dryRun: false,
      due: 6,
      deleted: 2,
      planned: 0,
      retry: 1,
      skipped: 2,
      failed: 0,
      eventsFailed: 0,
    });
    // Only events that exist are emitted.
    expect(mockStartChild).toHaveBeenCalledTimes(2);
    expect(mockStartChild.mock.calls.map((c) => c[1].args[0].subject.id)).toEqual([
      'a',
      'e',
    ]);
  });

  it('counts planned in a dry run and emits nothing', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: true,
      due: 2,
      integrationIds: ['a', 'b'],
    });
    mockActivities.ysocialDeleteChannelData.mockResolvedValue(outcome('planned'));
    expect(await ysocialChannelDeletionWorkflow()).toEqual({
      dryRun: true,
      due: 2,
      deleted: 0,
      planned: 2,
      retry: 0,
      skipped: 0,
      failed: 0,
      eventsFailed: 0,
    });
    expect(mockStartChild).not.toHaveBeenCalled();
  });

  it('does nothing without due channels', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 0,
      integrationIds: [],
    });
    expect(await ysocialChannelDeletionWorkflow()).toMatchObject({ due: 0, failed: 0 });
    expect(mockActivities.ysocialDeleteChannelData).not.toHaveBeenCalled();
    expect(mockStartChild).not.toHaveBeenCalled();
  });

  it('goes on after a failing channel and counts it', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 3,
      integrationIds: ['a', 'b', 'c'],
    });
    mockActivities.ysocialDeleteChannelData
      .mockRejectedValueOnce(new Error('platform down'))
      .mockResolvedValueOnce(outcome('deleted', eventFor('b')))
      .mockRejectedValueOnce(new Error('db down'));
    const summary = await ysocialChannelDeletionWorkflow();
    expect(summary).toMatchObject({ deleted: 1, failed: 2 });
    expect(mockActivities.ysocialDeleteChannelData).toHaveBeenCalledTimes(3);
    expect(mockStartChild).toHaveBeenCalledTimes(1);
  });

  it('counts a failing event start as deleted and eventsFailed, not failed, and goes on', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 2,
      integrationIds: ['a', 'b'],
    });
    mockActivities.ysocialDeleteChannelData
      .mockResolvedValueOnce(outcome('deleted', eventFor('a')))
      .mockResolvedValueOnce(outcome('retry'));
    mockStartChild.mockRejectedValueOnce(new Error('cannot start'));
    expect(await ysocialChannelDeletionWorkflow()).toMatchObject({
      deleted: 1,
      retry: 1,
      failed: 0,
      eventsFailed: 1,
    });
    expect(mockActivities.ysocialDeleteChannelData).toHaveBeenCalledTimes(2);
  });

  it('counts a duplicate event as emitted', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 1,
      integrationIds: ['a'],
    });
    mockActivities.ysocialDeleteChannelData.mockResolvedValue(
      outcome('deleted', eventFor('a'))
    );
    mockStartChild.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError('x', 'wf', 'ysocialDeliverEventWorkflow')
    );
    expect(await ysocialChannelDeletionWorkflow()).toMatchObject({
      deleted: 1,
      eventsFailed: 0,
    });
  });

  it('throws a cancellation of the event start on', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 2,
      integrationIds: ['a', 'b'],
    });
    mockActivities.ysocialDeleteChannelData.mockResolvedValue(
      outcome('deleted', eventFor('a'))
    );
    mockStartChild.mockRejectedValueOnce(new CancelledFailure('cancelled'));
    await expect(ysocialChannelDeletionWorkflow()).rejects.toBeInstanceOf(
      CancelledFailure
    );
    expect(mockActivities.ysocialDeleteChannelData).toHaveBeenCalledTimes(1);
  });

  it('throws a cancellation on and stops', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockResolvedValue({
      dryRun: false,
      due: 3,
      integrationIds: ['a', 'b', 'c'],
    });
    mockActivities.ysocialDeleteChannelData
      .mockResolvedValueOnce(outcome('retry'))
      .mockRejectedValueOnce(new CancelledFailure('cancelled'));
    await expect(ysocialChannelDeletionWorkflow()).rejects.toBeInstanceOf(
      CancelledFailure
    );
    expect(mockActivities.ysocialDeleteChannelData).toHaveBeenCalledTimes(2);
  });

  it('lets a failure of the find activity through', async () => {
    mockActivities.ysocialFindChannelsForDeletion.mockRejectedValue(
      new Error('db down')
    );
    await expect(ysocialChannelDeletionWorkflow()).rejects.toThrow('db down');
  });
});
