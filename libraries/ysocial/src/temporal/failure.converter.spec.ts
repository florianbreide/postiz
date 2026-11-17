import {
  ApplicationFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
  ProtoFailure,
  TemporalFailure,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { YsocialFailureConverter } from './failure.converter';

const converter = new YsocialFailureConverter();
const payloadConverter = defaultPayloadConverter;
const SECRET = 'https://graph.example/me?access_token=EAAB-invented';

const chain = () =>
  ApplicationFailure.create({
    message: `top ${SECRET}`,
    type: 'TopError',
    nonRetryable: true,
    cause: new Error(`inner ${SECRET}`),
  });

const levels = (failure: ProtoFailure): ProtoFailure[] =>
  failure.cause ? [failure, ...levels(failure.cause)] : [failure];

const attributes = (failure: ProtoFailure) =>
  payloadConverter.fromPayload<{ message: string; stack_trace: string }>(
    failure.encodedAttributes!
  );

describe('YsocialFailureConverter.errorToFailure', () => {
  it('encodes every level of the cause chain', () => {
    const failure = converter.errorToFailure(chain(), payloadConverter);
    const all = levels(failure);
    expect(all).toHaveLength(2);
    for (const level of all) {
      expect(level.message).toBe('Encoded failure');
      expect(level.stackTrace).toBe('');
      expect(level.encodedAttributes).toBeDefined();
    }
    expect(attributes(all[0]).message).toBe(`top ${SECRET}`);
    expect(attributes(all[1]).message).toBe(`inner ${SECRET}`);
    expect(JSON.stringify(failure.cause?.message)).not.toContain(SECRET);
    expect(failure.applicationFailureInfo?.type).toBe('TopError');
  });

  it('encodes an already decoded raw chain of a rethrown TemporalFailure', () => {
    const err = new TemporalFailure('wrapper');
    err.failure = {
      message: `raw ${SECRET}`,
      stackTrace: 'at secret',
      cause: { message: `raw cause ${SECRET}`, stackTrace: 'at cause' },
    };
    const failure = converter.errorToFailure(err, payloadConverter);
    const all = levels(failure);
    expect(all).toHaveLength(2);
    for (const level of all) {
      expect(level.message).toBe('Encoded failure');
      expect(level.stackTrace).toBe('');
    }
    expect(attributes(all[0]).message).toBe(`raw ${SECRET}`);
    expect(attributes(all[1]).stack_trace).toBe('at cause');
  });

  it('keeps levels that are already encoded', () => {
    const once = converter.errorToFailure(chain(), payloadConverter);
    const err = new TemporalFailure('wrapper');
    err.failure = once;
    const twice = converter.errorToFailure(err, payloadConverter);
    expect(twice).toEqual(once);
    for (const level of levels(twice)) {
      expect(attributes(level).message).not.toBe('Encoded failure');
    }
  });
});

describe('YsocialFailureConverter.failureToError', () => {
  const roundTrip = () =>
    converter.failureToError(
      converter.errorToFailure(chain(), payloadConverter),
      payloadConverter
    ) as TemporalFailure;

  it('restores message and cause message', () => {
    const err = roundTrip();
    expect(err.message).toBe(`top ${SECRET}`);
    expect(err.cause?.message).toBe(`inner ${SECRET}`);
  });

  it('restores plaintext in err.failure and its cause, without encodedAttributes', () => {
    const err = roundTrip();
    expect(err.failure?.message).toBe(`top ${SECRET}`);
    expect(err.failure?.cause?.message).toBe(`inner ${SECRET}`);
    expect(err.failure?.encodedAttributes).toBeFalsy();
    expect(err.failure?.cause?.encodedAttributes).toBeFalsy();
  });

  // The failures of a real run come over the wire (protobuf), which fixes
  // the order of the keys. Post.error holds JSON.stringify(err).
  const overTheWire = (failure: ProtoFailure): ProtoFailure =>
    temporal.api.failure.v1.Failure.decode(
      temporal.api.failure.v1.Failure.encode(failure).finish()
    ) as ProtoFailure;

  const viaBoth = (wire: boolean) => {
    // One error object, so the stack traces are the same on both sides.
    const original = chain();
    const through = (f: ProtoFailure) => (wire ? overTheWire(f) : f);
    const plainConverter = new DefaultFailureConverter();
    return {
      plain: plainConverter.failureToError(
        through(plainConverter.errorToFailure(original, payloadConverter)),
        payloadConverter
      ),
      codec: converter.failureToError(
        through(converter.errorToFailure(original, payloadConverter)),
        payloadConverter
      ),
    };
  };

  it('gives the same JSON.stringify as DefaultFailureConverter for a failure from the wire', () => {
    const { plain, codec } = viaBoth(true);
    expect(JSON.stringify(codec)).toBe(JSON.stringify(plain));
  });

  it('gives the same JSON content as DefaultFailureConverter in memory', () => {
    const { plain, codec } = viaBoth(false);
    expect(JSON.parse(JSON.stringify(codec))).toEqual(
      JSON.parse(JSON.stringify(plain))
    );
  });
});
