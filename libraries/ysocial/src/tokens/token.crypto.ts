import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

/**
 * Encryption of the channel tokens Integration.token and refreshToken
 * (HANDOVER §9, PLAN E24, PR 25).
 *
 * Format: ys1:<kid>:<iv>:<tag>:<ciphertext>, iv, tag and ciphertext in
 * base64url. AES-256-GCM with a random 12-byte IV. kid is the start of the
 * SHA-256 of the key, so a wrong key gives a clear message. The additional
 * data ys1:<kid>:<field> binds a value to its field.
 *
 * Values without the prefix are plaintext from before the migration and are
 * returned as they are.
 *
 * The messages name variables, fields and key ids, never values.
 */

export const YSOCIAL_TOKEN_KEY_ENV = 'YSOCIAL_TOKEN_KEY';
export const YSOCIAL_TOKEN_PREFIX = 'ys1:';
export const YSOCIAL_TOKEN_FIELDS = ['token', 'refreshToken'] as const;
export type YsocialTokenField = (typeof YSOCIAL_TOKEN_FIELDS)[number];

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID_LENGTH = 8;

// storedKid: key id of the stored value, when the value names one.
export class YsocialTokenKeyError extends Error {
  constructor(message: string, readonly storedKid?: string) {
    super(message);
    this.name = 'YsocialTokenKeyError';
  }
}

export interface YsocialTokenKey {
  key: Buffer;
  kid: string;
}

type Env = Record<string, string | undefined>;

// First 8 hex characters of SHA-256 over the raw key. The same value comes
// from: printf '%s' "$KEY" | base64 -d | openssl dgst -sha256
export const ysocialTokenKeyId = (key: Buffer) =>
  createHash('sha256').update(key).digest('hex').slice(0, KID_LENGTH);

// undefined: no key configured. A configured key that is not exactly 32 bytes
// in base64 (openssl rand -base64 32) throws, the process must not start.
export const readYsocialTokenKey = (env: Env): YsocialTokenKey | undefined => {
  const value = env[YSOCIAL_TOKEN_KEY_ENV]?.trim();
  if (!value) {
    return undefined;
  }

  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
    throw new YsocialTokenKeyError(
      `${YSOCIAL_TOKEN_KEY_ENV} ist ungültig: erwartet 32 Byte als Base64 (openssl rand -base64 32)`
    );
  }

  return { key, kid: ysocialTokenKeyId(key) };
};

export const isYsocialEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(YSOCIAL_TOKEN_PREFIX);

const additionalData = (kid: string, field: YsocialTokenField) =>
  Buffer.from(`${YSOCIAL_TOKEN_PREFIX}${kid}:${field}`, 'utf8');

export const encryptYsocialToken = (
  value: string,
  field: YsocialTokenField,
  key: YsocialTokenKey
): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(key.kid, field));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);

  return [
    `${YSOCIAL_TOKEN_PREFIX}${key.kid}`,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
};

export const decryptYsocialToken = (
  value: string,
  field: YsocialTokenField,
  key: YsocialTokenKey | undefined
): string => {
  if (!isYsocialEncrypted(value)) {
    return value;
  }

  const parts = value.slice(YSOCIAL_TOKEN_PREFIX.length).split(':');
  const [kid, iv, tag, ciphertext] = parts.map((part, index) =>
    index ? Buffer.from(part, 'base64url') : part
  ) as [string, Buffer, Buffer, Buffer];
  if (
    parts.length !== 4 ||
    kid.length !== KID_LENGTH ||
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES
  ) {
    throw new YsocialTokenKeyError(
      `Kanal-Token (${field}) im Format ys1 ist beschädigt`
    );
  }

  if (!key) {
    throw new YsocialTokenKeyError(
      `${YSOCIAL_TOKEN_KEY_ENV} fehlt: Kanal-Token (${field}) ist mit Schlüssel ${kid} verschlüsselt`,
      kid
    );
  }

  if (kid !== key.kid) {
    throw new YsocialTokenKeyError(
      `${YSOCIAL_TOKEN_KEY_ENV} passt nicht: Kanal-Token (${field}) ist mit Schlüssel ${kid} verschlüsselt, ${YSOCIAL_TOKEN_KEY_ENV} hat ${key.kid}`,
      kid
    );
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(kid, field));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    throw new YsocialTokenKeyError(
      `Kanal-Token (${field}, Schlüssel ${kid}) lässt sich nicht entschlüsseln: verändert oder beschädigt`
    );
  }
};
