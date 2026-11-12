import { proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';

// The activity writes with a condition on the stored value, a retry of the
// whole run is safe. A missing key fails at once (non-retryable).
const { ysocialMigrateTokens } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '30 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 minute',
  },
});

// Encrypts the plaintext channel tokens once YSOCIAL_TOKEN_KEY is set (PLAN
// PR 25). Only started by hand, see apps/orchestrator/src/ysocial/README.md.
// The result holds counts only.
export async function ysocialTokenMigrationWorkflow(input?: {
  batchSize?: number;
}) {
  return ysocialMigrateTokens({ batchSize: input?.batchSize });
}
