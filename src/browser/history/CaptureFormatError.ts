/** The fixed parser allowance an `input-limit` refusal exhausted. */
export interface CaptureInputAllowance {
  readonly kind: "parser-nodes" | "nesting-depth";
  readonly limit: number;
  readonly unit: "parser nodes" | "nesting levels";
}

/** Expected malformed, unsupported or oversized producer data at a historical decoder boundary. */
export class CaptureFormatError extends Error {
  constructor(
    readonly reason:
      | "format"
      | "unsupported"
      | "input-limit"
      | "expanded-limit"
      | "limit",
    message: string,
    readonly pointer = "",
    cause?: unknown,
    /** Which allowance an `input-limit` exhausted, when the parser knows it. */
    readonly allowance?: CaptureInputAllowance,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
