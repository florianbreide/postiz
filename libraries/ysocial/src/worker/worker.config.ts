import { isServiceTokenConfigured } from '../service.token';

/**
 * Configuration of the ysocial Temporal worker in the orchestrator (PLAN E33).
 *
 * Fail-closed (HANDOVER §10, rule 3): without HUB_INTERNAL_URL,
 * HUB_INTERNAL_TOKEN and YSOCIAL_TEMPORAL_NAMESPACE the worker does not
 * start. Postiz itself keeps running. YSOCIAL_WORKER_ENABLED=false switches
 * the worker off on purpose (PLAN R24).
 *
 * The messages name variables, never their values.
 */

export const YSOCIAL_WORKER_ENABLED_ENV = 'YSOCIAL_WORKER_ENABLED';
export const HUB_INTERNAL_URL_ENV = 'HUB_INTERNAL_URL';
export const HUB_INTERNAL_TOKEN_ENV = 'HUB_INTERNAL_TOKEN';
export const YSOCIAL_TEMPORAL_NAMESPACE_ENV = 'YSOCIAL_TEMPORAL_NAMESPACE';

// Fixed task queue of the fork worker. The hub worker uses ysocial-hub.
export const YSOCIAL_TASK_QUEUE = 'ysocial-postiz';

// PLAN 3.3, PR 17: at most 5 platform calls at the same time.
export const YSOCIAL_MAX_CONCURRENT_ACTIVITIES = 5;

export interface YsocialWorkerConfig {
  temporalAddress: string;
  temporalTls: boolean;
  temporalApiKey?: string;
  namespace: string;
  taskQueue: string;
  hubUrl: string;
  hubToken: string;
}

// config is set exactly when ok is true. A plain object instead of a union:
// Postiz compiles without strictNullChecks, which turns off the narrowing.
export interface YsocialWorkerConfigResult {
  ok: boolean;
  disabled: boolean;
  problems: string[];
  config?: YsocialWorkerConfig;
}

type Env = Record<string, string | undefined>;

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

const postizNamespace = (env: Env) =>
  env.TEMPORAL_NAMESPACE?.trim() || 'default';

const readHubUrl = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { problem: `${HUB_INTERNAL_URL_ENV} fehlt` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (err) {
    return { problem: `${HUB_INTERNAL_URL_ENV} ist keine gültige Adresse` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: `${HUB_INTERNAL_URL_ENV} ist keine http(s)-Adresse` };
  }

  if (url.username || url.password) {
    return {
      problem: `${HUB_INTERNAL_URL_ENV} darf keine Zugangsdaten enthalten`,
    };
  }

  return { url: trimmed.replace(/\/+$/, '') };
};

export const readYsocialWorkerConfig = (
  env: Env
): YsocialWorkerConfigResult => {
  const enabled = env[YSOCIAL_WORKER_ENABLED_ENV]?.trim().toLowerCase();
  if (enabled && OFF_VALUES.has(enabled)) {
    return {
      ok: false,
      disabled: true,
      problems: [`${YSOCIAL_WORKER_ENABLED_ENV}=${enabled}`],
    };
  }

  const problems: string[] = [];

  const hub = readHubUrl(env[HUB_INTERNAL_URL_ENV]);
  if (hub.problem) {
    problems.push(hub.problem);
  }

  const hubToken = env[HUB_INTERNAL_TOKEN_ENV];
  if (!isServiceTokenConfigured(hubToken)) {
    problems.push(
      `${HUB_INTERNAL_TOKEN_ENV} fehlt oder ist kürzer als 32 Zeichen`
    );
  }

  const namespace = env[YSOCIAL_TEMPORAL_NAMESPACE_ENV]?.trim();
  if (!namespace) {
    problems.push(`${YSOCIAL_TEMPORAL_NAMESPACE_ENV} fehlt`);
  } else if (namespace === 'default' || namespace === postizNamespace(env)) {
    // Never run in the Postiz namespace: Postiz terminates foreign workflows
    // there by the postId search attribute (PLAN E13, R6).
    problems.push(
      `${YSOCIAL_TEMPORAL_NAMESPACE_ENV} ist der Namespace von Postiz`
    );
  }

  if (problems.length) {
    return { ok: false, disabled: false, problems };
  }

  return {
    ok: true,
    disabled: false,
    problems: [],
    config: {
      temporalAddress: env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233',
      temporalTls: env.TEMPORAL_TLS === 'true',
      temporalApiKey: env.TEMPORAL_API_KEY || undefined,
      namespace: namespace!,
      taskQueue: YSOCIAL_TASK_QUEUE,
      hubUrl: hub.url!,
      hubToken: hubToken!.trim(),
    },
  };
};
