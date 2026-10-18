import { randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { createHubEvent } from './hub.event';
import { HUB_EVENTS_PATH, HubDeliveryError, postHubEvent } from './hub.client';

// A mock hub on a free local port. It answers with the queued status codes
// and records every request.
const startMockHub = async (statuses: number[]) => {
  const requests: {
    url?: string;
    headers: IncomingMessage['headers'];
    body: any;
  }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.statusCode = statuses.shift() ?? 202;
      // No keep-alive, so no socket outlives the test.
      res.setHeader('connection', 'close');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const hubToken = randomBytes(32).toString('hex');
const event = createHubEvent({
  kind: 'ping',
  subject: { type: 'system', id: 'ysocial-worker' },
  stateKey: 'ysocial-ping-qa',
  occurredAt: '2026-10-19T07:00:00.000Z',
});

describe('postHubEvent', () => {
  it('posts the event with token, id header and JSON body', async () => {
    const hub = await startMockHub([202]);
    try {
      const result = await postHubEvent(event, { hubUrl: hub.url, hubToken });
      expect(result).toEqual({ status: 202, duplicate: false });
      expect(hub.requests).toHaveLength(1);
      const [request] = hub.requests;
      expect(request.url).toBe(HUB_EVENTS_PATH);
      expect(request.headers.authorization).toBe(`Bearer ${hubToken}`);
      expect(request.headers['idempotency-key']).toBe(event.id);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.body).toEqual(event);
    } finally {
      await hub.close();
    }
  });

  it('sends the same id again after a failed attempt', async () => {
    const hub = await startMockHub([503, 202]);
    try {
      await expect(
        postHubEvent(event, { hubUrl: hub.url, hubToken })
      ).rejects.toMatchObject({ retryable: true, status: 503 });
      await postHubEvent(event, { hubUrl: hub.url, hubToken });
      expect(hub.requests.map((r) => r.body.id)).toEqual([event.id, event.id]);
      expect(hub.requests.map((r) => r.headers['idempotency-key'])).toEqual([
        event.id,
        event.id,
      ]);
    } finally {
      await hub.close();
    }
  });

  it('counts 409 as already delivered', async () => {
    const hub = await startMockHub([409]);
    try {
      expect(await postHubEvent(event, { hubUrl: hub.url, hubToken })).toEqual({
        status: 409,
        duplicate: true,
      });
    } finally {
      await hub.close();
    }
  });

  it.each([401, 403, 408, 429, 500, 502, 503])(
    '%s is worth another attempt',
    async (status) => {
      const hub = await startMockHub([status]);
      try {
        await expect(
          postHubEvent(event, { hubUrl: hub.url, hubToken })
        ).rejects.toMatchObject({ retryable: true, status });
      } finally {
        await hub.close();
      }
    }
  );

  it.each([400, 404, 413, 422])('%s is final', async (status) => {
    const hub = await startMockHub([status]);
    try {
      await expect(
        postHubEvent(event, { hubUrl: hub.url, hubToken })
      ).rejects.toMatchObject({ retryable: false, status });
    } finally {
      await hub.close();
    }
  });

  it('reports an unreachable hub as retryable without URL or token', async () => {
    const hub = await startMockHub([]);
    await hub.close();
    const error = await postHubEvent(event, {
      hubUrl: hub.url,
      hubToken,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(HubDeliveryError);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(hubToken);
    expect(error.message).not.toContain('127.0.0.1');
  });

  it('gives up after the timeout', async () => {
    const never = () => new Promise<{ status: number }>(() => undefined);
    const slow = (_: string, init: { signal: AbortSignal }) =>
      new Promise<{ status: number }>((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
        );
        void never();
      });
    await expect(
      postHubEvent(event, { hubUrl: 'http://hub', hubToken }, slow as any, 20)
    ).rejects.toMatchObject({
      retryable: true,
      message: 'hub not reachable (TimeoutError)',
    });
  });
});
