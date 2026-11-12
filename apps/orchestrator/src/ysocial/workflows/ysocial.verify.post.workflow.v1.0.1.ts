import { ActivityFailure, proxyActivities, sleep } from '@temporalio/workflow';
import type { YsocialActivities } from '../ysocial.activities';
import {
  initialVerificationMemory,
  nextVerificationStep,
  PlatformCheck,
  VerificationMemory,
} from '../../../../../libraries/ysocial/src/verification/post.verification';
import { emitHubEvent } from './ysocial.emit';

const { ysocialLoadPostForVerification } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

// Read-only call, retrying it can never post anything.
const { ysocialCheckPostOnPlatform } = proxyActivities<YsocialActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 3,
    initialInterval: '20 seconds',
    backoffCoefficient: 1,
  },
});

const MIN_SLEEP_MS = 1_000;

/**
 * Checks one post, workflow id ysocial-verify-<postId>. Same as
 * ysocialVerifyPostWorkflow, but post.failed comes once per failed attempt:
 * a post that fails again after "Erneut versuchen" (PR 19) is reported again
 * with a new id. ysocialVerifyPostWorkflow stays for the runs started before.
 */
export async function ysocialVerifyPostWorkflowV101(input: { postId: string }) {
  const { postId } = input;
  let memory: VerificationMemory = initialVerificationMemory();
  let checks = 0;

  while (true) {
    const snapshot = await ysocialLoadPostForVerification({ postId });
    let step = nextVerificationStep({
      postId,
      snapshot,
      now: Date.now(),
      memory,
      failedPerAttempt: true,
    });

    if (step.needsPlatformCheck) {
      let platform: PlatformCheck;
      try {
        platform = await ysocialCheckPostOnPlatform({ postId });
        checks++;
      } catch (err) {
        if (!(err instanceof ActivityFailure)) {
          throw err;
        }
        platform = {
          result: 'unverifiable',
          reason: 'Die Plattform hat auf die Prüfung nicht geantwortet.',
        };
      }
      step = nextVerificationStep({
        postId,
        snapshot,
        platform,
        now: Date.now(),
        memory,
        failedPerAttempt: true,
      });
    }

    for (const event of step.events) {
      await emitHubEvent(event);
    }
    memory = step.memory;

    if (step.done) {
      return { postId, outcome: step.outcome, platformChecks: checks };
    }

    await sleep(Math.max(MIN_SLEEP_MS, (step.nextCheckAt ?? 0) - Date.now()));
  }
}
