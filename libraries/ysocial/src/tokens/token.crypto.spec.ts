import { createHash, randomBytes } from 'crypto';
import {
  decryptYsocialToken,
  encryptYsocialToken,
  isYsocialEncrypted,
  readYsocialTokenKey,
  YSOCIAL_TOKEN_KEY_ENV,
  YsocialTokenKey,
  YsocialTokenKeyError,
  ysocialTokenKeyId,
} from './token.crypto';

// Keys exist only at run time, nothing secret is in the repository.
const newKey = (): YsocialTokenKey => {
  const key = readYsocialTokenKey({
    [YSOCIAL_TOKEN_KEY_ENV]: randomBytes(32).toString('base64'),
  });
  if (!key) {
    throw new Error('test key missing');
  }
  return key;
};

const tokenValue = () => `tok-${randomBytes(12).toString('hex')}`;

// Every error message must carry neither the value nor the key.
const expectThrowsClean = (
  fn: () => unknown,
  secrets: string[],
  pattern?: RegExp
) => {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(YsocialTokenKeyError);
  const message = (error as Error).message;
  if (pattern) {
    expect(message).toMatch(pattern);
  }
  for (const secret of secrets) {
    expect(message).not.toContain(secret);
  }
  return message;
};

describe('ysocial token crypto', () => {
  const key = newKey();

  describe('round trip', () => {
    it.each([
      // Random at runtime, no token-like literal in the public repository.
      ['a random token', randomBytes(24).toString('base64url')],
      ['an empty string', ''],
      ['unicode', 'tökén 日本語 🔐 ñ'],
      ['a token with colons', 'a:b:c:ys1:d'],
      ['a long token', 'x'.repeat(20_000)],
    ])('%s', (_name, value) => {
      for (const field of ['token', 'refreshToken'] as const) {
        const encrypted = encryptYsocialToken(value, field, key);
        expect(decryptYsocialToken(encrypted, field, key)).toBe(value);
      }
    });

    it('uses a different IV every time', () => {
      const value = tokenValue();
      const first = encryptYsocialToken(value, 'token', key);
      const second = encryptYsocialToken(value, 'token', key);
      expect(first).not.toBe(second);
      expect(first.split(':')[2]).not.toBe(second.split(':')[2]);
    });
  });

  describe('format', () => {
    it('is ys1:<kid>:<iv>:<tag>:<ciphertext> in base64url', () => {
      const value = tokenValue();
      const encrypted = encryptYsocialToken(value, 'token', key);
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toBe('ys1');
      expect(parts[1]).toBe(key.kid);
      expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
      for (const part of parts.slice(2)) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      expect(Buffer.from(parts[2], 'base64url')).toHaveLength(12);
      expect(Buffer.from(parts[3], 'base64url')).toHaveLength(16);
      expect(encrypted).not.toContain(value);
      expect(isYsocialEncrypted(encrypted)).toBe(true);
    });

    it('has a kid that is the start of the SHA-256 of the raw key', () => {
      const expected = createHash('sha256')
        .update(key.key)
        .digest('hex')
        .slice(0, 8);
      expect(key.kid).toBe(expected);
      expect(ysocialTokenKeyId(key.key)).toBe(expected);
    });

    it('detects only the prefix as encrypted', () => {
      expect(isYsocialEncrypted('ys1:x')).toBe(true);
      expect(isYsocialEncrypted('ys2:x')).toBe(false);
      expect(isYsocialEncrypted('plain')).toBe(false);
      expect(isYsocialEncrypted(null)).toBe(false);
      expect(isYsocialEncrypted(undefined)).toBe(false);
      expect(isYsocialEncrypted(5)).toBe(false);
    });
  });

  describe('plaintext from before the migration', () => {
    it('comes back unchanged, with and without key', () => {
      for (const value of ['', 'plain-token', 'ys2:other', 'a:b:c']) {
        expect(decryptYsocialToken(value, 'token', key)).toBe(value);
        expect(decryptYsocialToken(value, 'refreshToken', undefined)).toBe(
          value
        );
      }
    });
  });

  describe('errors', () => {
    it('names both key ids for a wrong key and leaks no value', () => {
      const value = tokenValue();
      const other = newKey();
      const encrypted = encryptYsocialToken(value, 'token', key);
      const message = expectThrowsClean(
        () => decryptYsocialToken(encrypted, 'token', other),
        [value, key.key.toString('base64'), other.key.toString('base64')],
        /passt nicht/
      );
      expect(message).toContain(key.kid);
      expect(message).toContain(other.kid);
      expect(message).toContain('token');
    });

    it('says the key is missing for an encrypted value', () => {
      const value = tokenValue();
      const encrypted = encryptYsocialToken(value, 'refreshToken', key);
      const message = expectThrowsClean(
        () => decryptYsocialToken(encrypted, 'refreshToken', undefined),
        [value, key.key.toString('base64')],
        new RegExp(`${YSOCIAL_TOKEN_KEY_ENV} fehlt`)
      );
      expect(message).toContain(key.kid);
    });

    it('rejects a ciphertext moved to the other field', () => {
      const value = tokenValue();
      const asToken = encryptYsocialToken(value, 'token', key);
      const asRefresh = encryptYsocialToken(value, 'refreshToken', key);
      expectThrowsClean(
        () => decryptYsocialToken(asToken, 'refreshToken', key),
        [value, key.key.toString('base64')],
        /nicht entschlüsseln/
      );
      expectThrowsClean(
        () => decryptYsocialToken(asRefresh, 'token', key),
        [value, key.key.toString('base64')],
        /nicht entschlüsseln/
      );
    });

    const flip = (part: string) => {
      const bytes = Buffer.from(part, 'base64url');
      bytes[0] ^= 0xff;
      return bytes.toString('base64url');
    };

    it.each([
      ['iv', 2],
      ['tag', 3],
      ['ciphertext', 4],
    ])('rejects a changed %s', (_name, index) => {
      const value = tokenValue();
      const parts = encryptYsocialToken(value, 'token', key).split(':');
      parts[index] = flip(parts[index]);
      expectThrowsClean(
        () => decryptYsocialToken(parts.join(':'), 'token', key),
        [value, key.key.toString('base64')],
        /verändert oder beschädigt/
      );
    });

    it('rejects a truncated ciphertext', () => {
      const value = tokenValue();
      const parts = encryptYsocialToken(value, 'token', key).split(':');
      parts[4] = parts[4].slice(0, -2);
      expectThrowsClean(
        () => decryptYsocialToken(parts.join(':'), 'token', key),
        [value],
        /verändert oder beschädigt/
      );
    });

    it('rejects a changed kid as a foreign key', () => {
      const value = tokenValue();
      const parts = encryptYsocialToken(value, 'token', key).split(':');
      parts[1] = '00000000';
      expectThrowsClean(
        () => decryptYsocialToken(parts.join(':'), 'token', key),
        [value],
        /passt nicht/
      );
    });

    it.each([
      ['only the prefix', 'ys1:'],
      ['too few parts', 'ys1:abcdef01:AAAA'],
      ['too many parts', 'ys1:abcdef01:a:b:c:d'],
      ['a short kid', 'ys1:abc:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA'],
      ['a short iv', 'ys1:abcdef01:AAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA'],
      ['a short tag', 'ys1:abcdef01:AAAAAAAAAAAAAAAA:AAAA:AAAA'],
    ])('rejects a malformed value (%s)', (_name, value) => {
      for (const k of [key, undefined]) {
        expectThrowsClean(
          () => decryptYsocialToken(value, 'token', k),
          [key.key.toString('base64')],
          /beschädigt/
        );
      }
    });
  });

  describe('readYsocialTokenKey', () => {
    const b64 = (bytes: number) => randomBytes(bytes).toString('base64');

    it.each([
      ['missing', {}],
      ['empty', { [YSOCIAL_TOKEN_KEY_ENV]: '' }],
      ['blank', { [YSOCIAL_TOKEN_KEY_ENV]: '   ' }],
      ['undefined', { [YSOCIAL_TOKEN_KEY_ENV]: undefined }],
    ])('returns undefined when %s', (_name, env) => {
      expect(readYsocialTokenKey(env)).toBeUndefined();
    });

    it('accepts 32 bytes of base64, also with surrounding whitespace', () => {
      const value = b64(32);
      const read = readYsocialTokenKey({
        [YSOCIAL_TOKEN_KEY_ENV]: `  ${value}\n`,
      });
      expect(read?.key.toString('base64')).toBe(value);
      expect(read?.kid).toBe(ysocialTokenKeyId(read!.key));
    });

    it.each([
      ['31 bytes', b64(31)],
      ['33 bytes', b64(33)],
      ['hex', randomBytes(32).toString('hex')],
      [
        'non canonical base64',
        (() => {
          // The last character of 32 bytes carries two spare bits.
          const value = b64(32);
          const lastChar = value[42];
          const alphabet =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          const alt = alphabet[(alphabet.indexOf(lastChar) + 1) % 64];
          return value.slice(0, 42) + alt + value.slice(43);
        })(),
      ],
      ['not base64', 'this is not a key!!'],
      ['base64url alphabet', Buffer.alloc(32, 0xfb).toString('base64url')],
    ])('throws for %s without leaking the value', (_name, value) => {
      let error: unknown;
      try {
        readYsocialTokenKey({ [YSOCIAL_TOKEN_KEY_ENV]: value });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(YsocialTokenKeyError);
      expect((error as Error).message).toContain(YSOCIAL_TOKEN_KEY_ENV);
      expect((error as Error).message).not.toContain(value);
    });
  });
});
