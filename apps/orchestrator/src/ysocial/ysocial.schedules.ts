import {
  Client,
  ScheduleAlreadyRunning,
  ScheduleOptions,
  ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
} from '@temporalio/client';

/**
 * Temporal schedules of the ysocial worker. The worker creates them on start
 * and brings existing ones in line with this list, so a change here reaches
 * Temporal with the next deploy. Overlap SKIP: a run that takes longer than
 * the interval is not started twice. No search attributes (E13).
 */
export type YsocialSchedule = ScheduleOptions<
  ScheduleOptionsStartWorkflowAction<any>
>;

export const ysocialSchedules = (taskQueue: string): YsocialSchedule[] => [
  {
    // PLAN 3.3 PR 17: every minute, posts of the last 60 minutes.
    scheduleId: 'ysocial-post-verification',
    spec: { intervals: [{ every: '1 minute' }] },
    action: {
      type: 'startWorkflow',
      workflowType: 'ysocialPostVerificationWorkflow',
      workflowId: 'ysocial-post-verification',
      taskQueue,
      args: [],
      workflowExecutionTimeout: '5 minutes',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      // After a pause one catch-up run is enough, the next minute looks back
      // 60 minutes anyway.
      catchupWindow: '1 minute',
    },
  },
  {
    // PLAN 3.3 PR 18: hourly, database fields only. A quarter past, so it
    // never meets DailyHealth at 07:00.
    scheduleId: 'ysocial-channel-check',
    spec: { intervals: [{ every: '1 hour', offset: '15 minutes' }] },
    action: {
      type: 'startWorkflow',
      workflowType: 'ysocialChannelCheckWorkflow',
      workflowId: 'ysocial-channel-check',
      taskQueue,
      args: [],
      workflowExecutionTimeout: '10 minutes',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '10 minutes',
    },
  },
  {
    // PLAN 3.3 PR 18: DailyHealth at 07:00 in Berlin. The hub sends its
    // summary at 07:05 (E38).
    scheduleId: 'ysocial-daily-health',
    spec: {
      calendars: [{ hour: 7, minute: 0 }],
      timezone: 'Europe/Berlin',
    },
    action: {
      type: 'startWorkflow',
      workflowType: 'ysocialDailyHealthWorkflow',
      workflowId: 'ysocial-daily-health',
      taskQueue,
      args: [],
      workflowExecutionTimeout: '1 hour',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      // If the worker was down at 07:00, run as soon as it is back, up to 09:00.
      catchupWindow: '2 hours',
    },
  },
];

export const ensureYsocialSchedules = async (
  client: Client,
  schedules: YsocialSchedule[]
): Promise<{ created: string[]; updated: string[] }> => {
  const created: string[] = [];
  const updated: string[] = [];

  for (const schedule of schedules) {
    try {
      await client.schedule.create(schedule);
      created.push(schedule.scheduleId);
    } catch (err) {
      if (!(err instanceof ScheduleAlreadyRunning)) {
        throw err;
      }
      await client.schedule
        .getHandle(schedule.scheduleId)
        .update((previous) => ({
          ...previous,
          spec: schedule.spec,
          action: schedule.action,
          policies: schedule.policies,
        }));
      updated.push(schedule.scheduleId);
    }
  }

  return { created, updated };
};
