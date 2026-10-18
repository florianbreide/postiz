import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import type { HubEvent } from '../../../../../libraries/ysocial/src/events/hub.event';

// Delivery to the hub with retries for up to 24 hours (PLAN E35, R23). Every
// attempt sends the same event, so the hub sees the same id.
const { ysocialDeliverEvent } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '24 hours',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '15 minutes',
    nonRetryableErrorTypes: ['YsocialHubRejected'],
  },
});

export async function ysocialDeliverEventWorkflow(event: HubEvent) {
  const result = await ysocialDeliverEvent(event);
  return { eventId: event.id, ...result };
}
