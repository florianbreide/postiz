import { randomBytes } from 'crypto';
import { readYsocialWorkerConfig, YSOCIAL_TASK_QUEUE } from './worker.config';

const token = randomBytes(32).toString('hex');

const complete = {
  HUB_INTERNAL_URL: 'http://hub-web:3000/',
  HUB_INTERNAL_TOKEN: token,
  YSOCIAL_TEMPORAL_NAMESPACE: 'ysocial',
  TEMPORAL_ADDRESS: 'temporal:7233',
};

describe('readYsocialWorkerConfig', () => {
  it('starts with all three variables', () => {
    const result = readYsocialWorkerConfig(complete);
    expect(result).toEqual({
      ok: true,
      disabled: false,
      problems: [],
      config: {
        temporalAddress: 'temporal:7233',
        temporalTls: false,
        temporalApiKey: undefined,
        namespace: 'ysocial',
        taskQueue: YSOCIAL_TASK_QUEUE,
        hubUrl: 'http://hub-web:3000',
        hubToken: token,
      },
    });
    expect(YSOCIAL_TASK_QUEUE).toBe('ysocial-postiz');
  });

  it.each([
    'HUB_INTERNAL_URL',
    'HUB_INTERNAL_TOKEN',
    'YSOCIAL_TEMPORAL_NAMESPACE',
  ])('stays off without %s and names it', (name) => {
    const env: Record<string, string | undefined> = { ...complete };
    delete env[name];
    const result = readYsocialWorkerConfig(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.disabled).toBe(false);
      expect(result.problems.join(' ')).toContain(name);
    }
  });

  it('lists every missing variable at once', () => {
    const result = readYsocialWorkerConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(3);
    }
  });

  it('rejects a short hub token and never prints a value', () => {
    const result = readYsocialWorkerConfig({
      ...complete,
      HUB_INTERNAL_TOKEN: 'short-secret',
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('short-secret');
  });

  it.each([
    ['not a url', 'keine gültige Adresse'],
    ['ftp://hub-web', 'keine http(s)-Adresse'],
    ['http://user:pass@hub-web:3000', 'keine Zugangsdaten'],
  ])('rejects HUB_INTERNAL_URL %s', (value, message) => {
    const result = readYsocialWorkerConfig({
      ...complete,
      HUB_INTERNAL_URL: value,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(' ')).toContain(message);
      expect(result.problems.join(' ')).not.toContain('pass');
    }
  });

  it('never runs in the namespace of Postiz', () => {
    for (const env of [
      { ...complete, YSOCIAL_TEMPORAL_NAMESPACE: 'default' },
      {
        ...complete,
        TEMPORAL_NAMESPACE: 'postiz',
        YSOCIAL_TEMPORAL_NAMESPACE: 'postiz',
      },
    ]) {
      const result = readYsocialWorkerConfig(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems.join(' ')).toContain('Namespace von Postiz');
      }
    }
  });

  it.each(['false', 'FALSE', '0', 'off', 'no'])(
    'YSOCIAL_WORKER_ENABLED=%s switches the worker off',
    (value) => {
      const result = readYsocialWorkerConfig({
        ...complete,
        YSOCIAL_WORKER_ENABLED: value,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.disabled).toBe(true);
      }
    }
  );

  it('YSOCIAL_WORKER_ENABLED=true keeps the checks', () => {
    expect(
      readYsocialWorkerConfig({ ...complete, YSOCIAL_WORKER_ENABLED: 'true' })
        .ok
    ).toBe(true);
    expect(
      readYsocialWorkerConfig({
        YSOCIAL_WORKER_ENABLED: 'true',
      }).ok
    ).toBe(false);
  });

  it('takes TLS and API key like Postiz', () => {
    const result = readYsocialWorkerConfig({
      ...complete,
      TEMPORAL_TLS: 'true',
      TEMPORAL_API_KEY: 'key',
    });
    expect(result.config?.temporalTls).toBe(true);
    expect(result.config?.temporalApiKey).toBe('key');
  });
});
