import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import { emitHubEvent } from './ysocial.emit';

// One platform call per channel, in sequence. Read-only, so a retry of the
// whole run is safe.
const { ysocialRunDailyHealth } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '20 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '1 minute',
  },
});

// Started at 07:00 Europe/Berlin by the schedule ysocial-daily-health
// (HANDOVER §7.1, PLAN 3.3 PR 18). One event per finding, then the summary.
export async function ysocialDailyHealthWorkflow() {
  const { events, summary } = await ysocialRunDailyHealth({});
  for (const event of events) {
    await emitHubEvent(event);
  }
  return summary;
}
