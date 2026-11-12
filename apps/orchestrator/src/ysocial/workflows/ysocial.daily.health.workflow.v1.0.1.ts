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

// Redis only. A retry applies the same changes again.
const { ysocialSaveChannelProblems } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
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
