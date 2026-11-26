import { err, ok, type Result } from "./result.js";
import type {
  TargetFailureFacts,
  TargetFailureOf,
  TruncatedExtent,
} from "./targetFailure.js";

/**
 * How a byte-format parser failed. The byte-structure outcomes are the
 * {@link TargetFailureOf} variants themselves, so a parser's fact is the
 * target failure every projection reads; only `limit` is parser-specific.
 *
 * - `malformed`: the bytes violate the format's structure.
 * - `truncated`: a declared structure starts in the bytes but ends past them.
 * - `unsupported`: the bytes use a form outside this decoder's coverage.
 * - `limit`: a named decode budget stopped the parse; the input is not shown
 *   to be invalid.
 */
export type ParseFailureKind =
  | "malformed"
  | "truncated"
  | "unsupported"
  | "limit";

/**
 * The limit a parse stopped at: its stable name, the maximum in force, and,
 * when the parser measured it, the smallest value that would admit the input.
 * `required` is a bigint when the measured size exceeds a safe integer.
 */
export interface LimitRef {
  readonly name: string;
  readonly maximum: number;
  readonly required?: number | bigint;
}

/** JSON-safe public facts for the named limit a parser exhausted. */
export const reportedParseLimit = ({ name, maximum, required }: LimitRef) => ({
  boundary: name,
  maximum,
  ...(required === undefined
    ? {}
    : { required: typeof required === "bigint" ? String(required) : required }),
});

/** A parse outcome the parser established, carried with its facts. */
export type ParseFailure =
  | TargetFailureOf<"malformed" | "truncated" | "unsupported">
  | (TargetFailureFacts & {
      readonly kind: "limit";
      readonly limit: LimitRef;
    });

/** The one throwable carrier for a {@link ParseFailure}. */
export class ParseFailureError<
  Kind extends ParseFailureKind = ParseFailureKind,
> extends Error {
  readonly _tag = "ParseFailureError";

  constructor(
    readonly failure: Extract<ParseFailure, { readonly kind: Kind }>,
    options?: ErrorOptions,
  ) {
    super(failure.detail, options);
    this.name = "ParseFailureError";
  }

  get kind(): Kind {
    return this.failure.kind as Kind;
  }
}

/** Where the failure was found, and the failure that revealed it. */
type ParseFailureSite = Pick<TargetFailureFacts, "offset" | "field"> & {
  readonly cause?: unknown;
};

const failureWith = <Kind extends ParseFailureKind>(
  failure: Extract<ParseFailure, { readonly kind: Kind }>,
  cause: unknown,
): ParseFailureError<Kind> =>
  new ParseFailureError(failure, cause === undefined ? undefined : { cause });

/** The bytes violate the format's structure. */
export const malformedInput = (
  format: string,
  detail: string,
  { cause, ...at }: ParseFailureSite = {},
): ParseFailureError<"malformed"> =>
  failureWith({ kind: "malformed", format, detail, ...at }, cause);

/** A declared structure starts in the bytes but ends past them. */
export const truncatedInput = (
  format: string,
  detail: string,
  {
    cause,
    extent,
    ...at
  }: ParseFailureSite & { readonly extent?: TruncatedExtent } = {},
): ParseFailureError<"truncated"> =>
  failureWith(
    {
      kind: "truncated",
      format,
      detail,
      ...at,
      ...(extent === undefined ? {} : { extent }),
    },
    cause,
  );

/** The bytes use a form outside this decoder's coverage. */
export const unsupportedInput = (
  format: string,
  detail: string,
  {
    cause,
    undecodedContent = false,
    ...at
  }: ParseFailureSite & { readonly undecodedContent?: boolean } = {},
): ParseFailureError<"unsupported"> =>
  failureWith(
    { kind: "unsupported", format, detail, ...at, undecodedContent },
    cause,
  );

/** A named decode budget stopped the parse before the input was shown invalid. */
export const decodeLimit = (
  format: string,
  detail: string,
  limit: LimitRef,
  { cause, ...at }: ParseFailureSite = {},
): ParseFailureError<"limit"> =>
  failureWith({ kind: "limit", format, detail, ...at, limit }, cause);

/**
 * What a JavaScript or Node `RangeError` says about the work that raised it.
 *
 * - `stack-overflow`: the call stack ran out. A REA defect or host limit,
 *   never evidence about the input bytes.
 * - `host-capacity`: a string, array or buffer exceeded what the runtime can
 *   represent or allocate.
 *
 * Any other `RangeError` (including one REA code threw itself) returns
 * `undefined`: its meaning belongs to whoever threw it.
 */
export type HostRangeErrorKind = "stack-overflow" | "host-capacity";

const HOST_CAPACITY_MESSAGES = new Set([
  "Invalid string length",
  "Array buffer allocation failed",
  "Invalid array length",
]);
const HOST_CAPACITY_CODES = new Set([
  "ERR_STRING_TOO_LONG",
  "ERR_BUFFER_TOO_LARGE",
]);

/** Classify a host `RangeError`; the one place that interprets one. */
export const hostRangeErrorKind = (
  cause: unknown,
): HostRangeErrorKind | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const code = "code" in cause ? String(cause.code) : undefined;
  // Node raises an over-long string as a plain Error with this code.
  if (code !== undefined && HOST_CAPACITY_CODES.has(code))
    return "host-capacity";
  if (!(cause instanceof RangeError)) return undefined;
  if (cause.message === "Maximum call stack size exceeded")
    return "stack-overflow";
  if (
    HOST_CAPACITY_MESSAGES.has(cause.message) ||
    cause.message.startsWith("Invalid typed array length")
  )
    return "host-capacity";
  return undefined;
};

/** A stack overflow or host capacity failure: never evidence about the input. */
export const isHostLimitFailure = (cause: unknown): boolean => {
  const kind = hostRangeErrorKind(cause);
  return kind === "stack-overflow" || kind === "host-capacity";
};

/**
 * The format failure a parse step established, or `undefined` when the cause
 * says nothing about the input. Host errors do not identify the operation
 * that failed: buffer reads, writes and allocations can share error codes.
 * Readers must report their own bounds failures at the read boundary.
 */
export const parseFailureFromCause = (
  cause: unknown,
): ParseFailureError | undefined => {
  if (cause instanceof ParseFailureError) return cause;
  return undefined;
};

/** Return a parser's reported failure and let unexpected exceptions reach the caller. */
export const captureParseFailure = <T>(
  read: () => T,
): Result<T, ParseFailureError> => {
  try {
    return ok(read());
  } catch (cause) {
    const failure = parseFailureFromCause(cause);
    if (failure === undefined) throw cause;
    return err(failure);
  }
};
