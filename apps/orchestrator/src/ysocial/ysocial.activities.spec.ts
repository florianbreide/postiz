import { randomBytes } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import { ApplicationFailure } from '@temporalio/common';
import {
  buildYsocialActivities,
  YsocialActivities,
  ysocialActivityNames,
} from './ysocial.activities';
import { createHubEvent } from '../../../../libraries/ysocial/src/events/hub.event';

const POSTIZ_ACTIVITIES = join(__dirname, '..', 'activities');

// Method names of the Postiz activity classes, read from their source files.
// Importing them would load every provider SDK.
const postizActivityNames = () =>
  readdirSync(POSTIZ_ACTIVITIES)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      Array.from(
        readFileSync(join(POSTIZ_ACTIVITIES, file), 'utf8').matchAll(
          /^\s{2}(?:async\s+)?([a-zA-Z_]\w*)\s*\(/gm
        ),
        (match) => match[1]
      )
    )
    .filter((name) => name !== 'constructor');

describe('ysocial activities', () => {
  it('all start with "ysocial" (PLAN R34)', () => {
    expect(ysocialActivityNames().length).toBeGreaterThan(0);
    for (const name of ysocialActivityNames()) {
      expect(name).toMatch(/^ysocial[A-Z]/);
    }
  });

  it('share no name with a Postiz activity', () => {
    const postiz = postizActivityNames();
    expect(postiz).toEqual(
      expect.arrayContaining(['getIntegrationsById', 'refreshToken'])
    );
    for (const name of ysocialActivityNames()) {
      expect(postiz).not.toContain(name);
    }
  });

  it('are registered bound to the instance', () => {
    const instance = new YsocialActivities();
    const activities = buildYsocialActivities(instance);
    expect(Object.keys(activities).sort()).toEqual(
      ysocialActivityNames().sort()
    );
  });
});

describe('ysocialDeliverEvent', () => {
  const env = { ...process.env };
  const hubToken = randomBytes(32).toString('hex');
  const event = createHubEvent({
    kind: 'ping',
    subject: { type: 'system', id: 'ysocial-worker' },
    stateKey: 'qa',
    occurredAt: '2026-10-19T07:00:00.000Z',
  });
  let server: Server;
  let statuses: number[];
  let received: string[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push(JSON.parse(body).id);
        res.statusCode = statuses.shift() ?? 202;
        res.setHeader('connection', 'close');
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
  });

  beforeEach(() => {
    statuses = [];
    received = [];
    const { port } = server.address() as AddressInfo;
    process.env.HUB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    process.env.HUB_INTERNAL_TOKEN = hubToken;
    process.env.YSOCIAL_TEMPORAL_NAMESPACE = 'ysocial';
  });

  afterAll(async () => {
    process.env = env;
    await new Promise((resolve) => server.close(resolve));
  });

  const deliver = () => new YsocialActivities().ysocialDeliverEvent(event);

  it('delivers to the mock hub', async () => {
    expect(await deliver()).toEqual({ status: 202, duplicate: false });
    expect(received).toEqual([event.id]);
  });

  it('asks Temporal for another attempt with the same event while the hub is down', async () => {
    statuses = [503];
    const error = await deliver().catch((err) => err);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.type).toBe('YsocialHubUnavailable');
    expect(error.nonRetryable).toBe(false);
    await deliver();
    expect(received).toEqual([event.id, event.id]);
  });

  it('stops on a final answer of the hub', async () => {
    statuses = [400];
    const error = await deliver().catch((err) => err);
    expect(error.type).toBe('YsocialHubRejected');
    expect(error.nonRetryable).toBe(true);
  });

  it('sends nothing without configuration', async () => {
    delete process.env.HUB_INTERNAL_TOKEN;
    const error = await deliver().catch((err) => err);
    expect(error.type).toBe('YsocialNotConfigured');
    expect(received).toEqual([]);
  });
});
