import {
  ParentClosePolicy,
  startChild,
  WorkflowIdReusePolicy,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import {
  deliveryWorkflowId,
  HubEvent,
} from '../../../../../libraries/ysocial/src/events/hub.event';

/**
 * Hands an event to its own delivery workflow and returns at once.
 *
 * The delivery retries for up to 24 hours (E35) without blocking the caller.
 * The workflow id comes from the event id: an event that was delivered is
 * not delivered again, a failed delivery can be started again.
 *
 * No search attributes, never postId (E13).
 */
export const emitHubEvent = async (
  event: HubEvent
): Promise<'started' | 'duplicate'> => {
  try {
    await startChild('ysocialDeliverEventWorkflow', {
      workflowId: deliveryWorkflowId(event.id),
      args: [event],
      parentClosePolicy: ParentClosePolicy.ABANDON,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    });
    return 'started';
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return 'duplicate';
    }
    throw err;
  }
};
