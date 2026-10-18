import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { readYsocialWorkerConfig } from '../../../../libraries/ysocial/src/worker/worker.config';

/**
 * Temporal client in the ysocial namespace, for schedules and for starting
 * workflows from activities. The connection opens on first use. Postiz's own
 * TemporalService stays on the Postiz namespace and is not used here.
 */
@Injectable()
export class YsocialTemporalClient implements BeforeApplicationShutdown {
  private _client?: Promise<Client>;

  get(): Promise<Client> {
    if (!this._client) {
      const result = readYsocialWorkerConfig(process.env);
      if (!result.ok) {
        return Promise.reject(new Error('ysocial worker is not configured'));
      }
      const config = result.config!;
      this._client = Connection.connect({
        address: config.temporalAddress,
        ...(config.temporalTls ? { tls: true } : {}),
        ...(config.temporalApiKey ? { apiKey: config.temporalApiKey } : {}),
      })
        .then(
          (connection) =>
            new Client({ connection, namespace: config.namespace })
        )
        .catch((err) => {
          this._client = undefined;
          throw err;
        });
    }
    return this._client;
  }

  async beforeApplicationShutdown() {
    const client = await this._client?.catch((): undefined => undefined);
    this._client = undefined;
    await client?.connection.close().catch((): undefined => undefined);
  }
}
