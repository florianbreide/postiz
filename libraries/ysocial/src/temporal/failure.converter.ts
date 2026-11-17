import {
  DefaultFailureConverter,
  PayloadConverter,
  ProtoFailure,
} from '@temporalio/common';

/**
 * Failure converter of the payload codec (PLAN PR 40). Postiz calls Graph
 * endpoints with access_token in the URL, and error messages of fetch and
 * axios may carry the URL. Like encodeCommonAttributes of Temporal, message
 * and stack trace move into a payload, which the codec encrypts. The Temporal
 * UI then shows "Encoded failure", the container logs stay the source for
 * debugging.
 *
 * Two differences to encodeCommonAttributes:
 * - Writing, every failure of the cause chain is encoded, not only the top.
 *   A workflow that rethrows an activity error sends the chain it received,
 *   and the cause of an activity error would stay plaintext otherwise.
 * - Reading, the whole chain is restored, not only the error objects.
 *   Postiz writes JSON.stringify(err) to Post.error, and that includes
 *   err.failure with its causes. Post.error keeps its format this way.
 *
 * The worker loads this file by path (failureConverterPath), also into the
 * workflow bundle: only @temporalio/common, no Node APIs.
 */

const ENCODED_MESSAGE = 'Encoded failure';

const encodedFailure = (
  failure: ProtoFailure,
  payloadConverter: PayloadConverter
): ProtoFailure => {
  const encoded: ProtoFailure = { ...failure };
  if (!failure.encodedAttributes || failure.message !== ENCODED_MESSAGE) {
    encoded.encodedAttributes = payloadConverter.toPayload({
      message: failure.message ?? '',
      stack_trace: failure.stackTrace ?? '',
    });
    encoded.message = ENCODED_MESSAGE;
    encoded.stackTrace = '';
  }
  if (failure.cause) {
    encoded.cause = encodedFailure(failure.cause, payloadConverter);
  }
  return encoded;
};

// Keys in the order of a plain failure decoded from the wire (message,
// source, stackTrace first), so JSON.stringify gives the same string.
const decodedFailure = (
  failure: ProtoFailure,
  payloadConverter: PayloadConverter
): ProtoFailure => {
  let decoded: ProtoFailure = { ...failure };
  if (failure.encodedAttributes) {
    const attributes = payloadConverter.fromPayload<{
      message?: unknown;
      stack_trace?: unknown;
    }>(failure.encodedAttributes);
    const {
      encodedAttributes: _encoded,
      message,
      source,
      stackTrace,
      ...rest
    } = failure;
    decoded = {
      message:
        typeof attributes?.message === 'string' ? attributes.message : message,
      source,
      stackTrace:
        typeof attributes?.stack_trace === 'string'
          ? attributes.stack_trace
          : stackTrace,
      ...rest,
    };
  }
  if (failure.cause) {
    decoded.cause = decodedFailure(failure.cause, payloadConverter);
  }
  return decoded;
};

export class YsocialFailureConverter extends DefaultFailureConverter {
  override errorToFailure(
    err: unknown,
    payloadConverter: PayloadConverter
  ): ProtoFailure {
    return encodedFailure(
      this.errorToFailureInner(err, payloadConverter),
      payloadConverter
    );
  }

  override failureToError(
    failure: ProtoFailure,
    payloadConverter: PayloadConverter
  ): Error {
    return super.failureToError(
      decodedFailure(failure, payloadConverter),
      payloadConverter
    );
  }
}

export const failureConverter = new YsocialFailureConverter();
