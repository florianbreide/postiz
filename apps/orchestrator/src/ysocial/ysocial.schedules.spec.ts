import { ScheduleAlreadyRunning } from '@temporalio/client';
import { ensureYsocialSchedules, ysocialSchedules } from './ysocial.schedules';

describe('ysocial schedules', () => {
  const schedules = ysocialSchedules('ysocial-postiz');

  it('starts PostVerification every minute on ysocial-postiz', () => {
    const verification = schedules.find(
      (s) => s.scheduleId === 'ysocial-post-verification'
    )!;
    expect(verification.spec).toEqual({ intervals: [{ every: '1 minute' }] });
    expect(verification.action).toMatchObject({
      type: 'startWorkflow',
      workflowType: 'ysocialPostVerificationWorkflow',
      taskQueue: 'ysocial-postiz',
      args: [],
    });
    expect(verification.policies).toMatchObject({ overlap: 'SKIP' });
  });

  it('all start ysocial workflows, never with search attributes', () => {
    for (const schedule of schedules) {
      expect(schedule.scheduleId).toMatch(/^ysocial-/);
      expect(String(schedule.action.workflowType)).toMatch(
        /^ysocial\w+Workflow$/
      );
      expect(Object.keys(schedule.action)).not.toEqual(
        expect.arrayContaining(['searchAttributes'])
      );
      expect(Object.keys(schedule.action)).not.toEqual(
        expect.arrayContaining(['typedSearchAttributes'])
      );
    }
  });

  it('creates missing schedules and updates existing ones', async () => {
    const update = jest.fn(async (fn: (previous: any) => any) =>
      fn({
        spec: { intervals: [{ every: '5 minutes' }] },
        state: { paused: false },
      })
    );
    const create = jest
      .fn()
      .mockRejectedValueOnce(
        new ScheduleAlreadyRunning('exists', 'ysocial-post-verification')
      );
    const client = {
      schedule: { create, getHandle: jest.fn(() => ({ update })) },
    } as any;

    const result = await ensureYsocialSchedules(client, schedules);

    expect(result.updated).toEqual(['ysocial-post-verification']);
    const updated = await update.mock.results[0].value;
    expect(updated.spec).toEqual({ intervals: [{ every: '1 minute' }] });
    expect(updated.state).toEqual({ paused: false });

    create.mockResolvedValue({});
    expect(await ensureYsocialSchedules(client, schedules)).toEqual({
      created: schedules.map((s) => s.scheduleId),
      updated: [],
    });
  });

  it('passes other errors on', async () => {
    const client = {
      schedule: { create: jest.fn().mockRejectedValue(new Error('denied')) },
    } as any;
    await expect(ensureYsocialSchedules(client, schedules)).rejects.toThrow(
      'denied'
    );
  });
});
