import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import { emitHubEvent } from './ysocial.emit';

// One platform call per channel, in sequence. Read-only and it saves
// nothing, so a retry of the whole check is safe.
const { ysocialPrepareDailyHealth } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '20 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '1 minute',
  },
});

// Redis only and cheap, a retry applies the same changes again. It keeps
// trying for 10 minutes: without the saved state a problem solved before
// the next run would get no channel.reconnected. The check above takes up to
// 41 minutes, both fit into the hour of the schedule.
const { ysocialSaveChannelProblems } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
  },
});

// Started at 07:00 Europe/Berlin by the schedule ysocial-daily-health.
// Same as ysocialDailyHealthWorkflow, but the state of the reported channels
// is saved only after every event is handed to its delivery: a retried check
// still finds the problems unreported and loses no event.
// ysocialDailyHealthWorkflow stays for the runs started before.
export async function ysocialDailyHealthWorkflowV101() {
  const { events, summary, changes } = await ysocialPrepareDailyHealth({});
  for (const event of events) {
    await emitHubEvent(event);
  }
  await ysocialSaveChannelProblems({ changes });
  return summary;
}
