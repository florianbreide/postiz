import {
  DynamicModule,
  FactoryProvider,
  Logger,
  Provider,
} from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { DataConverter } from '@temporalio/common';
import {
  TEMPORAL_CLIENT,
  TEMPORAL_MODULE_OPTIONS,
  TemporalOptions,
} from 'nestjs-temporal-core';
import { YsocialTokenKey } from '../tokens/token.crypto';
import {
  readYsocialTemporalKey,
  YSOCIAL_TEMPORAL_KEY_ENV,
  YsocialPayloadCodec,
  YsocialTemporalKeyError,
} from './payload.codec';
// Loaded by path below, the import makes the build emit it next to this file.
import './failure.converter';

/**
 * Hooks the payload codec into the TemporalModule of Postiz (patch 6 in
 * libraries/nestjs-libraries/src/temporal/temporal.module.ts, PLAN PR 40).
 *
 * nestjs-temporal-core passes workerOptions on to Worker.create, so every
 * worker of the orchestrator gets the data converter there. Its client takes
 * no dataConverter: the TEMPORAL_CLIENT provider builds one on the same
 * connection with the data converter instead. Backend and orchestrator share
 * this module, so both read and write encrypted payloads.
 *
 * Start check, fail-closed like the token key (PR 25). The namespace keeps
 * the key id in its data under ysocial-payload-codec once the codec ran
 * there. Without the key, or with another one, Postiz then does not start:
 * it could not read the running workflows and would write plaintext again.
 * Without an answer from Temporal Postiz does not start either, it cannot
 * tell whether the namespace is marked.
 */

export const YSOCIAL_PAYLOAD_CODEC_MARKER = 'ysocial-payload-codec';

// Values of the marker that mean "never on" or "switched off on purpose".
const MARKER_OFF = ['', 'off'];

const CHECK_TIMEOUT_MS = 10_000;
const CHECK_ATTEMPTS = 3;
const CHECK_PAUSE_MS = 5_000;

export interface YsocialPayloadCodecState {
  codec: 'on' | 'off';
  kid?: string;
  marked?: boolean;
}

type NamespaceConnection = Pick<Connection, 'workflowService' | 'withDeadline'>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GRPC_NOT_FOUND = 5;

// Status code of a failed gRPC call for the message, never its text.
const grpcStatus = (err: unknown) => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number'
    ? `gRPC-Status ${code}`
    : (err as Error)?.name || 'Fehler';
};

export const ysocialDataConverter = (
  codec: YsocialPayloadCodec
): DataConverter => ({
  payloadCodecs: [codec],
  failureConverterPath: require.resolve('./failure.converter'),
});

export class YsocialPayloadCodecCheck {
  private readonly _logger = new Logger('ysocial');

  constructor(
    private _connection: NamespaceConnection,
    private _namespace: string,
    private _pauseMs = CHECK_PAUSE_MS
  ) {}

  async run(key: YsocialTokenKey | undefined) {
    try {
      const state = await this.check(key);
      this._logger.log(
        state.codec === 'on'
          ? `temporal codec on (key ${state.kid}${
              state.marked ? `, namespace ${this._namespace} marked` : ''
            })`
          : `temporal codec off: ${YSOCIAL_TEMPORAL_KEY_ENV} fehlt, Temporal-Payloads bleiben Klartext`
      );
      return state;
    } catch (err) {
      if (err instanceof YsocialTemporalKeyError) {
        this._logger.error(`temporal codec check failed: ${err.message}`);
      }
      throw err;
    }
  }

  async check(
    key: YsocialTokenKey | undefined
  ): Promise<YsocialPayloadCodecState> {
    const marker = await this.readMarker();
    const on = !MARKER_OFF.includes(marker);
    if (!key) {
      if (on) {
        throw new YsocialTemporalKeyError(
          `${YSOCIAL_TEMPORAL_KEY_ENV} fehlt: Namespace ${this._namespace} ist mit Schlüssel ${marker} verschlüsselt, ohne den Schlüssel startet Postiz nicht`
        );
      }
      return { codec: 'off' };
    }

    if (on && marker !== key.kid) {
      throw new YsocialTemporalKeyError(
        `${YSOCIAL_TEMPORAL_KEY_ENV} passt nicht: Namespace ${this._namespace} ist mit Schlüssel ${marker} verschlüsselt, ${YSOCIAL_TEMPORAL_KEY_ENV} hat ${key.kid}`
      );
    }

    if (!on) {
      // UpdateNamespace merges data, other keys and the config stay.
      try {
        await this._connection.withDeadline(Date.now() + CHECK_TIMEOUT_MS, () =>
          this._connection.workflowService.updateNamespace({
            namespace: this._namespace,
            updateInfo: {
              data: { [YSOCIAL_PAYLOAD_CODEC_MARKER]: key.kid },
            },
          })
        );
      } catch (err) {
        throw new YsocialTemporalKeyError(
          `Markierung im Namespace ${
            this._namespace
          } nicht gesetzt (${grpcStatus(err)}), ohne sie startet Postiz nicht`
        );
      }
      return { codec: 'on', kid: key.kid, marked: true };
    }

    return { codec: 'on', kid: key.kid };
  }

  // '' when the namespace has no marker. The CLI stores values as JSON
  // (--data 'ysocial-payload-codec="off"'), the quotes are dropped.
  private async readMarker(): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { namespaceInfo } = await this._connection.withDeadline(
          Date.now() + CHECK_TIMEOUT_MS,
          () =>
            this._connection.workflowService.describeNamespace({
              namespace: this._namespace,
            })
        );
        return (namespaceInfo?.data?.[YSOCIAL_PAYLOAD_CODEC_MARKER] ?? '')
          .replace(/^"(.*)"$/, '$1')
          .trim();
      } catch (err) {
        if (attempt >= CHECK_ATTEMPTS) {
          throw new YsocialTemporalKeyError(
            (err as { code?: unknown })?.code === GRPC_NOT_FOUND
              ? `Namespace ${
                  this._namespace
                } gibt es in Temporal nicht (${grpcStatus(
                  err
                )}), ohne die Prüfung startet Postiz nicht`
              : `Temporal nicht erreichbar: Namespace ${
                  this._namespace
                } nach ${CHECK_ATTEMPTS} Versuchen nicht lesbar (${grpcStatus(
                  err
                )}), ohne die Prüfung startet Postiz nicht`
          );
        }
        await sleep(this._pauseMs);
      }
    }
  }
}

const findProvider = (providers: Provider[], token: string) =>
  providers.find(
    (provider) =>
      typeof provider === 'object' &&
      'provide' in provider &&
      provider.provide === token
  );

/**
 * Wraps TemporalModule.register(...) of Postiz. Throws at import when
 * nestjs-temporal-core changed the providers it relies on, so an update can
 * never switch the codec off silently.
 */
export const withYsocialPayloadCodec = (
  module: DynamicModule,
  env: Record<string, string | undefined> = process.env
): DynamicModule => {
  const providers = module.providers || [];
  const options = findProvider(providers, TEMPORAL_MODULE_OPTIONS);
  const client = findProvider(providers, TEMPORAL_CLIENT);
  if (
    !options ||
    !('useValue' in options) ||
    !client ||
    !('useFactory' in client)
  ) {
    throw new YsocialTemporalKeyError(
      'nestjs-temporal-core hat keinen Provider TEMPORAL_MODULE_OPTIONS (useValue) oder TEMPORAL_CLIENT (useFactory) mehr, ysocial patch 6 prüfen'
    );
  }

  let key: YsocialTokenKey | undefined;
  try {
    key = readYsocialTemporalKey(env);
  } catch (err) {
    new Logger('ysocial').error(
      `temporal codec check failed: ${(err as Error).message}`
    );
    throw err;
  }

  const dataConverter =
    key && ysocialDataConverter(new YsocialPayloadCodec(key));
  const temporalOptions = options.useValue as TemporalOptions;
  if (dataConverter) {
    for (const worker of [
      ...(temporalOptions.workers || []),
      ...(temporalOptions.worker ? [temporalOptions.worker] : []),
    ]) {
      worker.workerOptions = {
        ...worker.workerOptions,
        dataConverter: dataConverter as Record<string, unknown>,
      };
    }
  }

  const originalFactory = client.useFactory;
  const encryptedClient: FactoryProvider = {
    ...client,
    useFactory: async (...args: unknown[]) => {
      const original = (await originalFactory(...args)) as Client | null;
      if (!original) {
        // nestjs-temporal-core returns null after failed attempts. Workers
        // would still start, without the check and maybe without the codec.
        const error = new YsocialTemporalKeyError(
          'Temporal-Client fehlt (nestjs-temporal-core konnte ihn nicht bauen), ohne die Prüfung startet Postiz nicht'
        );
        new Logger('ysocial').error(
          `temporal codec check failed: ${error.message}`
        );
        throw error;
      }
      await new YsocialPayloadCodecCheck(
        original.connection as Connection,
        original.options.namespace
      ).run(key);
      if (!dataConverter) {
        return original;
      }
      return new Client({
        connection: original.connection,
        namespace: original.options.namespace,
        dataConverter,
      });
    },
  };

  return {
    ...module,
    providers: providers.map((provider) =>
      provider === client ? encryptedClient : provider
    ),
  };
};
