import { randomBytes } from 'crypto';
import { METADATA_ENCODING_KEY, Payload } from '@temporalio/common';
import {
  isYsocialEncryptedPayload,
  readYsocialTemporalKey,
  YSOCIAL_PAYLOAD_ENCODING,
  YSOCIAL_PAYLOAD_KEY_ID,
  YSOCIAL_TEMPORAL_KEY_ENV,
  YsocialPayloadCodec,
  YsocialTemporalKeyError,
} from './payload.codec';
import { YSOCIAL_TOKEN_KEY_ENV } from '../tokens/token.crypto';

const newKeyBase64 = () => randomBytes(32).toString('base64');
const keyOf = (base64: string) =>
  readYsocialTemporalKey({ [YSOCIAL_TEMPORAL_KEY_ENV]: base64 })!;

const plain = (encoding: string, data: string): Payload => ({
  metadata: { [METADATA_ENCODING_KEY]: Buffer.from(encoding) },
  data: Buffer.from(data),
});

const SECRET = 'access_token=EAAB-invented-secret';
const jsonPayload = plain('json/plain', JSON.stringify({ token: SECRET }));

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
};

describe('YsocialPayloadCodec', () => {
  const key = keyOf(newKeyBase64());
  const codec = new YsocialPayloadCodec(key);

  it('round-trips metadata and data, also for several payloads and empty data', async () => {
    const payloads: Payload[] = [
      jsonPayload,
      plain('binary/plain', 'second'),
      { metadata: { [METADATA_ENCODING_KEY]: Buffer.from('binary/null') } },
      plain('json/plain', ''),
    ];
    const decoded = await codec.decode(await codec.encode(payloads));
    expect(decoded).toHaveLength(4);
    decoded.forEach((payload, index) => {
      expect(payload.metadata).toEqual(payloads[index].metadata);
      expect(Buffer.from(payload.data || [])).toEqual(
        Buffer.from(payloads[index].data || [])
      );
    });
  });

  it('marks payloads as encrypted with the key id and hides the plaintext', async () => {
    const [encrypted] = await codec.encode([jsonPayload]);
    expect(isYsocialEncryptedPayload(encrypted)).toBe(true);
    expect(
      Buffer.from(encrypted.metadata![METADATA_ENCODING_KEY]).toString()
    ).toBe(YSOCIAL_PAYLOAD_ENCODING);
    expect(
      Buffer.from(encrypted.metadata![YSOCIAL_PAYLOAD_KEY_ID]).toString()
    ).toBe(key.kid);
    expect(Buffer.from(encrypted.data!).includes(SECRET)).toBe(false);
    expect(Object.keys(encrypted.metadata!)).toHaveLength(2);
  });

  it('uses a random IV, so two encodes differ', async () => {
    const [a] = await codec.encode([jsonPayload]);
    const [b] = await codec.encode([jsonPayload]);
    expect(Buffer.from(a.data!).equals(Buffer.from(b.data!))).toBe(false);
  });

  it.each([
    ['json/plain', plain('json/plain', '{"a":1}')],
    ['binary/null', plain('binary/null', '')],
  ])('returns %s payloads of old runs unchanged', async (_name, payload) => {
    const [decoded] = await codec.decode([payload]);
    expect(decoded).toBe(payload);
    expect(isYsocialEncryptedPayload(payload)).toBe(false);
  });

  it('rejects a payload of another key, naming both key ids and no values', async () => {
    const other = new YsocialPayloadCodec(keyOf(newKeyBase64()));
    const [encrypted] = await other.encode([jsonPayload]);
    const err = await rejection(codec.decode([encrypted]));
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('passt nicht');
    expect(err.message).toContain(other.kid);
    expect(err.message).toContain(codec.kid);
    expect(err.message).not.toContain(key.key.toString('base64'));
    expect(err.message).not.toContain(SECRET);
  });

  it('rejects an encrypted payload without a key id', async () => {
    const [encrypted] = await codec.encode([jsonPayload]);
    delete encrypted.metadata![YSOCIAL_PAYLOAD_KEY_ID];
    const err = await rejection(codec.decode([encrypted]));
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('unbekannt');
  });

  it('rejects changed data', async () => {
    const [encrypted] = await codec.encode([jsonPayload]);
    const data = Buffer.from(encrypted.data!);
    data[data.length - 1] ^= 0xff;
    const err = await rejection(codec.decode([{ ...encrypted, data }]));
    expect(err).toBeInstanceOf(YsocialTemporalKeyError);
    expect(err.message).toContain('verändert oder beschädigt');
    expect(err.message).toContain(key.kid);
    expect(err.message).not.toContain(SECRET);
  });

  it('rejects data that are too short or missing', async () => {
    const [encrypted] = await codec.encode([jsonPayload]);
    for (const data of [Buffer.alloc(27), undefined]) {
      const err = await rejection(codec.decode([{ ...encrypted, data }]));
      expect(err).toBeInstanceOf(YsocialTemporalKeyError);
      expect(err.message).toContain('beschädigt');
    }
  });
});

describe('readYsocialTemporalKey', () => {
  const read = (
    value: string | undefined,
    extra: Record<string, string> = {}
  ) => readYsocialTemporalKey({ [YSOCIAL_TEMPORAL_KEY_ENV]: value, ...extra });

  it.each([[undefined], [''], ['   ']])('is undefined for %j', (value) => {
    expect(read(value)).toBeUndefined();
  });

  it('reads a valid key, also with surrounding spaces', () => {
    const base64 = newKeyBase64();
    const key = read(` ${base64} `)!;
    expect(key.key.toString('base64')).toBe(base64);
    expect(key.kid).toMatch(/^[0-9a-f]{8}$/);
  });

  it.each([
    ['wrong length', randomBytes(16).toString('base64')],
    ['not base64', 'not a key!'],
    [
      'non-canonical base64',
      randomBytes(32).toString('base64').slice(0, -2) + 'B=',
    ],
    ['base64url', randomBytes(32).toString('base64url') + 'x'],
  ])('throws "ist ungültig" for %s without the value', (_name, value) => {
    let thrown: Error | undefined;
    try {
      read(value);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(YsocialTemporalKeyError);
    expect(thrown!.message).toContain('ist ungültig');
    expect(thrown!.message).not.toContain(value);
  });

  it('throws when it is the same key as YSOCIAL_TOKEN_KEY', () => {
    const base64 = newKeyBase64();
    expect(() => read(base64, { [YSOCIAL_TOKEN_KEY_ENV]: base64 })).toThrow(
      /derselbe Schlüssel/
    );
  });

  it('accepts another token key', () => {
    expect(
      read(newKeyBase64(), { [YSOCIAL_TOKEN_KEY_ENV]: newKeyBase64() })
    ).toBeDefined();
  });

  it('is not blocked by an invalid YSOCIAL_TOKEN_KEY', () => {
    expect(
      read(newKeyBase64(), { [YSOCIAL_TOKEN_KEY_ENV]: 'broken' })
    ).toBeDefined();
  });
});
