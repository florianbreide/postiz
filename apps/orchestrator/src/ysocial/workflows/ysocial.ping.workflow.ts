import { workflowInfo } from '@temporalio/workflow';
import { createHubEvent } from '../../../../../libraries/ysocial/src/events/hub.event';
import { emitHubEvent } from './ysocial.emit';

// Test event for the path fork -> hub (PLAN PR 16 QA 4, PR 21 QA 4). Start by
// hand in the namespace ysocial, see apps/orchestrator/src/ysocial/README.md.
// The event id comes from the workflow id: the same ping is one event.
export async function ysocialPingWorkflow() {
  const { workflowId, startTime } = workflowInfo();
  const event = createHubEvent({
    kind: 'ping',
    subject: { type: 'system', id: 'ysocial-worker' },
    stateKey: workflowId,
    occurredAt: startTime,
    reason: 'Ping aus dem ysocial-Worker',
  });

  const delivery = await emitHubEvent(event);
  return { eventId: event.id, delivery };
}
