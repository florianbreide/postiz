import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

// Test workflows for ysocial.temporal.codec.integration.spec.ts.

export interface CodecProbeActivities {
  ysocialCodecProbeChannel(id: string): Promise<{ id: string; token: string }>;
  ysocialCodecProbeFail(url: string): Promise<void>;
}

const { ysocialCodecProbeChannel, ysocialCodecProbeFail } =
  proxyActivities<CodecProbeActivities>({
    startToCloseTimeout: '10 seconds',
    retry: { maximumAttempts: 1 },
  });

export const codecProbeContinue = defineSignal('codecProbeContinue');

// Shaped like refreshTokenWorkflow: an activity hands a channel row with its
// token to the workflow. It waits for a signal between two activities, so a
// run can start before the codec and end after it.
export async function ysocialCodecProbeWorkflow(input: {
  id: string;
  wait: boolean;
}) {
  let go = !input.wait;
  setHandler(codecProbeContinue, () => {
    go = true;
  });

  const first = await ysocialCodecProbeChannel(input.id);
  await condition(() => go);
  const second = await ysocialCodecProbeChannel(input.id);

  return { first: first.token, second: second.token };
}

// Shaped like the post workflow: an activity fails with a BadBody-like
// ApplicationFailure, the workflow keeps JSON.stringify(err) the way
// changeState writes it to Post.error, or fails itself.
export async function ysocialCodecProbeFailureWorkflow(input: {
  url: string;
  rethrow: boolean;
}) {
  try {
    await ysocialCodecProbeFail(input.url);
    return '';
  } catch (err) {
    if (input.rethrow) {
      throw err;
    }
    return JSON.stringify(err);
  }
}
