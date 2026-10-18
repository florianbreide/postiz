import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';

const { ysocialStartPostVerifications } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

// Started every minute by the schedule ysocial-post-verification (PR 17).
// windowMinutes only for a run by hand with a larger window (QA 3); the
// schedule passes nothing and the last 60 minutes count.
export async function ysocialPostVerificationWorkflow(input?: {
  windowMinutes?: number;
}) {
  return ysocialStartPostVerifications({
    windowMinutes: input?.windowMinutes,
  });
}
