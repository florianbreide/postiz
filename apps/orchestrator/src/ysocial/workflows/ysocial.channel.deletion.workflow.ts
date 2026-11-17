import { isCancellation, proxyActivities } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import { emitHubEvent } from './ysocial.emit';

// Database only, a retry reads the same channels again.
const { ysocialFindChannelsForDeletion } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '30 seconds',
  },
});

// One channel: up to two platform calls of 15 s each, then its media within
// DELETION_MEDIA_BUDGET_MS (7 minutes), so no heartbeat is needed. Every
// step can run again: a revoked authorization answers already_invalid the
// second time, deleted media are not found again, cleared tokens end the
// channel. An event of an attempt that failed after clearing is lost.
const { ysocialDeleteChannelData } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 2,
    initialInterval: '1 minute',
  },
});

// Started every hour by the schedule ysocial-channel-deletion (Datenschutz
// D1). Without YSOCIAL_DELETION_ENABLED=true the activities only count and
// log. One channel at a time, so a failed channel does not stop the others;
// the next run tries it again.
export async function ysocialChannelDeletionWorkflow() {
  const { dryRun, due, integrationIds } = await ysocialFindChannelsForDeletion(
    {}
  );
  const summary = {
    dryRun,
    due,
    deleted: 0,
    planned: 0,
    retry: 0,
    skipped: 0,
    failed: 0,
    // Tokens cleared, but the event did not reach its delivery workflow.
    eventsFailed: 0,
  };

  for (const integrationId of integrationIds) {
    let outcome: Awaited<ReturnType<typeof ysocialDeleteChannelData>>;
    try {
      outcome = await ysocialDeleteChannelData({ integrationId });
    } catch (err) {
      if (isCancellation(err)) {
        throw err;
      }
      summary.failed++;
      continue;
    }

    summary[outcome.result?.status || 'skipped']++;
    if (outcome.event) {
      try {
        await emitHubEvent(outcome.event);
      } catch (err) {
        if (isCancellation(err)) {
          throw err;
        }
        summary.eventsFailed++;
      }
    }
  }
  return summary;
}
