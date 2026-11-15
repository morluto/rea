/**
 * How a byte-format parser failed. One algebra for every format, so the
 * public category depends on what the parser established, not on which error
 * class it happened to throw.
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

interface ParseFailureFacts {
  /** The format being decoded, such as `elf` or `windows-shortcut`. */
  readonly format: string;
  readonly detail: string;
  /** Byte offset of the structure that failed, when the parser knows it. */
  readonly offset?: number;
  /** The structure or field that failed, when the parser names it. */
  readonly field?: string;
}

/** A parse outcome the parser established, carried with its facts. */
export type ParseFailure = ParseFailureFacts &
  (
    | { readonly kind: "malformed" }
    | { readonly kind: "truncated" }
    | {
        readonly kind: "unsupported";
        /** The input holds the content, in a form this decoder cannot read. */
        readonly undecodedContent: boolean;
      }
    | {
        readonly kind: "limit";
        readonly limit: { readonly name: string; readonly maximum: number };
      }
  );

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

/** The bytes violate the format's structure. */
export const malformedInput = (
  format: string,
  detail: string,
  facts?: Pick<ParseFailureFacts, "offset" | "field">,
): ParseFailureError<"malformed"> =>
  new ParseFailureError({ kind: "malformed", format, detail, ...facts });

/** The bytes use a form outside this decoder's coverage. */
export const unsupportedInput = (
  format: string,
  detail: string,
  facts?: Pick<ParseFailureFacts, "offset" | "field"> & {
    readonly undecodedContent?: boolean;
  },
): ParseFailureError<"unsupported"> =>
  new ParseFailureError({
    kind: "unsupported",
    format,
    detail,
    ...facts,
    undecodedContent: facts?.undecodedContent ?? false,
  });
