import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';

// The Temporal workflow APIs only work inside a worker. Here they are mocked,
// the workflow functions run as plain async functions.
const mockStartChild = jest.fn();
const mockActivities = {
  ysocialDeliverEvent: jest.fn(),
  ysocialStartPostVerifications: jest.fn(),
};
const mockInfo = {
  workflowId: 'ysocial-ping-qa',
  startTime: new Date('2026-10-19T07:00:00.000Z'),
};

jest.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: jest.requireActual('@temporalio/workflow/lib/interfaces')
    .ParentClosePolicy,
  WorkflowIdReusePolicy:
    jest.requireActual('@temporalio/common').WorkflowIdReusePolicy,
  startChild: (...args: unknown[]) => mockStartChild(...args),
  workflowInfo: () => mockInfo,
  proxyActivities: () => mockActivities,
}));

import * as ysocialWorkflows from './index';
import { ysocialPingWorkflow } from './ysocial.ping.workflow';
import { ysocialDeliverEventWorkflow } from './ysocial.deliver.event.workflow';
import { emitHubEvent } from './ysocial.emit';
import { ysocialPostVerificationWorkflow } from './ysocial.post.verification.workflow';

const POSTIZ_WORKFLOWS = join(__dirname, '..', '..', 'workflows');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : name.endsWith('.ts')
      ? [path]
      : [];
  });

const postizWorkflowNames = () =>
  sourceFiles(POSTIZ_WORKFLOWS).flatMap((file) =>
    Array.from(
      readFileSync(file, 'utf8').matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)/g
      ),
      (match) => match[1]
    )
  );

beforeEach(() => {
  mockStartChild.mockReset();
  mockActivities.ysocialDeliverEvent.mockReset();
  mockActivities.ysocialStartPostVerifications.mockReset();
});

describe('ysocial workflows', () => {
  it('are all prefixed and unknown to Postiz (PLAN R34)', () => {
    const names = Object.keys(ysocialWorkflows);
    expect(names).toEqual(
      expect.arrayContaining([
        'ysocialPingWorkflow',
        'ysocialDeliverEventWorkflow',
        'ysocialPostVerificationWorkflow',
        'ysocialVerifyPostWorkflow',
      ])
    );
    const postiz = postizWorkflowNames();
    expect(postiz).toContain('missingPostWorkflow');
    for (const name of names) {
      expect(name).toMatch(/^ysocial[A-Z]\w*Workflow$/);
      expect(postiz).not.toContain(name);
    }
  });
});

describe('ysocialPingWorkflow', () => {
  it('hands one event to the delivery workflow', async () => {
    mockStartChild.mockResolvedValue({});
    const result = await ysocialPingWorkflow();

    expect(result).toEqual({
      eventId: 'ping:ysocial-worker:ysocial-ping-qa',
      delivery: 'started',
    });
    expect(mockStartChild).toHaveBeenCalledTimes(1);
    const [type, options] = mockStartChild.mock.calls[0];
    expect(type).toBe('ysocialDeliverEventWorkflow');
    expect(options).toEqual({
      workflowId: 'ysocial-event-ping:ysocial-worker:ysocial-ping-qa',
      args: [
        expect.objectContaining({
          id: 'ping:ysocial-worker:ysocial-ping-qa',
          kind: 'ping',
          occurredAt: '2026-10-19T07:00:00.000Z',
          source: 'postiz',
        }),
      ],
      parentClosePolicy: 'ABANDON',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
    });
  });
});

describe('emitHubEvent', () => {
  const event = {
    id: 'ping:ysocial-worker:qa',
  } as any;

  it('treats an event that is already on its way as done', async () => {
    mockStartChild.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        'already started',
        'ysocial-event-ping:ysocial-worker:qa',
        'ysocialDeliverEventWorkflow'
      )
    );
    expect(await emitHubEvent(event)).toBe('duplicate');
  });

  it('passes other errors on', async () => {
    mockStartChild.mockRejectedValue(new Error('boom'));
    await expect(emitHubEvent(event)).rejects.toThrow('boom');
  });
});

describe('ysocialDeliverEventWorkflow', () => {
  it('delivers the event through the activity', async () => {
    mockActivities.ysocialDeliverEvent.mockResolvedValue({
      status: 202,
      duplicate: false,
    });
    const event = { id: 'ping:ysocial-worker:qa' } as any;
    expect(await ysocialDeliverEventWorkflow(event)).toEqual({
      eventId: 'ping:ysocial-worker:qa',
      status: 202,
      duplicate: false,
    });
    expect(mockActivities.ysocialDeliverEvent).toHaveBeenCalledWith(event);
  });
});

describe('ysocialPostVerificationWorkflow', () => {
  it('looks at the last 60 minutes when the schedule starts it', async () => {
    mockActivities.ysocialStartPostVerifications.mockResolvedValue({
      due: 2,
      started: 1,
      alreadyStarted: 1,
    });
    expect(await ysocialPostVerificationWorkflow()).toEqual({
      due: 2,
      started: 1,
      alreadyStarted: 1,
    });
    expect(mockActivities.ysocialStartPostVerifications).toHaveBeenCalledWith({
      windowMinutes: undefined,
    });
  });

  it('passes a larger window from a run by hand', async () => {
    await ysocialPostVerificationWorkflow({ windowMinutes: 2880 });
    expect(mockActivities.ysocialStartPostVerifications).toHaveBeenCalledWith({
      windowMinutes: 2880,
    });
  });
});
