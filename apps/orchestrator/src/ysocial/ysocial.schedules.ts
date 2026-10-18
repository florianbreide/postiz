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
