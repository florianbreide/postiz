import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  METADATA_ENCODING_KEY,
  Payload,
  PayloadCodec,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import {
  readYsocialTokenKey,
  ysocialTokenKeyId,
  YsocialTokenKey,
} from '../tokens/token.crypto';

/**
 * Payload codec for the Temporal namespace of Postiz (PLAN E51, PR 40).
 * Postiz passes whole channel rows with their tokens between workflows and
 * activities, so the history in Temporal and every backup of it held them in
 * plaintext. The codec encrypts every payload a client or worker writes.
 *
 * Format like the encryption sample of Temporal: the whole payload (metadata
 * and data) as protobuf, encrypted with AES-256-GCM and a random 12-byte IV.
 * The new payload has the encoding binary/encrypted and names the key id.
 * data is iv | tag | ciphertext. The additional data binds it to the key id.
 *
 * Payloads with another encoding are plaintext from before the codec and are
 * returned as they are, so runs started before keep running.
 *
 * The messages name variables and key ids, never values.
 */

export const YSOCIAL_TEMPORAL_KEY_ENV = 'YSOCIAL_TEMPORAL_KEY';
export const YSOCIAL_PAYLOAD_ENCODING = 'binary/encrypted';
export const YSOCIAL_PAYLOAD_KEY_ID = 'encryption-key-id';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class YsocialTemporalKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YsocialTemporalKeyError';
  }
}

type Env = Record<string, string | undefined>;

// undefined: no key configured, the codec stays off. A configured key that is
// not exactly 32 bytes in base64 (openssl rand -base64 32), or the key of the
// channel tokens, throws: the process must not start.
export const readYsocialTemporalKey = (
  env: Env
): YsocialTokenKey | undefined => {
  const value = env[YSOCIAL_TEMPORAL_KEY_ENV]?.trim();
  if (!value) {
    return undefined;
  }

  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
    throw new YsocialTemporalKeyError(
      `${YSOCIAL_TEMPORAL_KEY_ENV} ist ungültig: erwartet 32 Byte als Base64 (openssl rand -base64 32)`
    );
  }

  const kid = ysocialTokenKeyId(key);
  let tokenKey: YsocialTokenKey | undefined;
  try {
    tokenKey = readYsocialTokenKey(env);
  } catch {
    // The token key check reports an invalid token key itself.
  }
  if (tokenKey?.kid === kid) {
    throw new YsocialTemporalKeyError(
      `${YSOCIAL_TEMPORAL_KEY_ENV} ist derselbe Schlüssel wie YSOCIAL_TOKEN_KEY (${kid}): je ein eigener Schlüssel`
    );
  }

  return { key, kid };
};

const text = (value: Uint8Array | null | undefined) =>
  value ? Buffer.from(value).toString('utf8') : undefined;

const additionalData = (kid: string) =>
  Buffer.from(`${YSOCIAL_PAYLOAD_ENCODING}:${kid}`, 'utf8');

export const isYsocialEncryptedPayload = (payload: Payload) =>
  text(payload.metadata?.[METADATA_ENCODING_KEY]) === YSOCIAL_PAYLOAD_ENCODING;

export class YsocialPayloadCodec implements PayloadCodec {
  constructor(private readonly _key: YsocialTokenKey) {}

  get kid() {
    return this._key.kid;
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => this.encrypt(payload));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => this.decrypt(payload));
  }

  private encrypt(payload: Payload): Payload {
    const plain = temporal.api.common.v1.Payload.encode(payload).finish();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this._key.key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(additionalData(this._key.kid));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: Buffer.from(YSOCIAL_PAYLOAD_ENCODING),
        [YSOCIAL_PAYLOAD_KEY_ID]: Buffer.from(this._key.kid),
      },
      data: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    };
  }

  private decrypt(payload: Payload): Payload {
    if (!isYsocialEncryptedPayload(payload)) {
      return payload;
    }

    const kid = text(payload.metadata?.[YSOCIAL_PAYLOAD_KEY_ID]);
    if (kid !== this._key.kid) {
      throw new YsocialTemporalKeyError(
        `${YSOCIAL_TEMPORAL_KEY_ENV} passt nicht: Temporal-Payload ist mit Schlüssel ${
          kid || 'unbekannt'
        } verschlüsselt, ${YSOCIAL_TEMPORAL_KEY_ENV} hat ${this._key.kid}`
      );
    }

    const data = Buffer.from(payload.data || []);
    if (data.length < IV_BYTES + TAG_BYTES) {
      throw new YsocialTemporalKeyError(
        `Temporal-Payload (Schlüssel ${kid}) ist beschädigt`
      );
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this._key.key,
        data.subarray(0, IV_BYTES),
        { authTagLength: TAG_BYTES }
      );
      decipher.setAAD(additionalData(kid));
      decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(data.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return temporal.api.common.v1.Payload.decode(plain);
    } catch {
      throw new YsocialTemporalKeyError(
        `Temporal-Payload (Schlüssel ${kid}) lässt sich nicht entschlüsseln: verändert oder beschädigt`
      );
    }
  }
}
