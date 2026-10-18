import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import { emitHubEvent } from './ysocial.emit';

const { ysocialCheckChannels } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
  },
});

// Started every hour by the schedule ysocial-channel-check (PR 18): channels
// disconnected or back, from the database fields only.
export async function ysocialChannelCheckWorkflow() {
  const { channels, events } = await ysocialCheckChannels({});
  for (const event of events) {
    await emitHubEvent(event);
  }
  return { channels, events: events.map((event) => event.id) };
}
