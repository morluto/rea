import { ParseFailureError } from "../../domain/parseFailure.js";
import type { ArtifactLimitBoundary } from "../../domain/artifactOperationError.js";
import type { ArtifactFixedLimit } from "../../resources/index.js";

/** The ParseFailure format of a historical web network capture. */
export const CAPTURE_FORMAT = "web-network-capture";

/**
 * Each named capture decode budget: the public control that raises it (null
 * for a fixed allowance), the unit of its maximum, and the wire reason a
 * decoder child reports for it. Protobuf bodies decode in the parent and have
 * no wire reason; the mitmproxy bridge reports the same wire reasons.
 */
export const CAPTURE_LIMITS = {
  "nesting-depth": {
    parameter: "max_nesting_depth",
    unit: "nesting levels",
    reply: "input-limit",
    expected: "maximum_capture_nesting",
  },
  "parser-nodes": {
    parameter: null,
    unit: "parser nodes",
    reply: null,
    expected: "maximum_parser_nodes",
  },
  "expanded-input": {
    parameter: "max_input_bytes",
    unit: "bytes",
    reply: "expanded-limit",
    expected: "maximum_expanded_capture_bytes",
  },
  "protobuf-body": {
    parameter: "max_input_bytes",
    unit: "bytes",
    reply: null,
    expected: "maximum_protobuf_body_bytes",
  },
  "protobuf-decoding": {
    parameter: "max_reply_bytes",
    unit: "bytes",
    reply: null,
    expected: "maximum_encoded_capture_bytes",
  },
} as const;
export type CaptureLimitName = keyof typeof CAPTURE_LIMITS;

/** A limit a decoder child can report on the reply wire. */
type CaptureReplyLimitName = {
  [
    Name in CaptureLimitName
  ]: (typeof CAPTURE_LIMITS)[Name]["reply"] extends null ? never : Name;
}[CaptureLimitName];
const CAPTURE_REPLY_LIMITS = (
  Object.keys(CAPTURE_LIMITS) as CaptureLimitName[]
).filter(
  (name): name is CaptureReplyLimitName => CAPTURE_LIMITS[name].reply !== null,
);

/** The limit whose wire reason a decoder child reported, if any. */
export const captureLimitForReply = (
  reason: string,
): CaptureReplyLimitName | undefined =>
  CAPTURE_REPLY_LIMITS.find((name) => CAPTURE_LIMITS[name].reply === reason);

/**
 * A fixed ceiling that the reader under a capture decoder named, and the
 * resource it bounds. The capture keeps the reader's ceiling instead of
 * attributing the refusal to one of its own budgets.
 */
export interface CaptureFixedCeiling {
  readonly fixedAllowance: ArtifactFixedLimit;
  readonly boundary: ArtifactLimitBoundary;
}

/** Expected malformed, unsupported or oversized producer data at a historical decoder boundary. */
export class CaptureFormatError extends ParseFailureError<
  "malformed" | "unsupported" | "limit"
> {
  constructor(
    kind: "malformed" | "unsupported",
    message: string,
    pointer?: string,
    cause?: unknown,
  );
  constructor(
    limit:
      | { readonly name: CaptureLimitName; readonly maximum: number }
      | CaptureFixedCeiling,
    message: string,
    pointer?: string,
  );
  constructor(
    kind:
      | "malformed"
      | "unsupported"
      | { readonly name: CaptureLimitName; readonly maximum: number }
      | CaptureFixedCeiling,
    message: string,
    pointer = "",
    cause?: unknown,
  ) {
    const field = pointer === "" ? {} : { field: pointer };
    super(
      kind === "malformed"
        ? { kind, format: CAPTURE_FORMAT, detail: message, ...field }
        : kind === "unsupported"
          ? {
              kind,
              format: CAPTURE_FORMAT,
              detail: message,
              undecodedContent: false,
              ...field,
            }
          : {
              kind: "limit",
              format: CAPTURE_FORMAT,
              detail: message,
              limit:
                "fixedAllowance" in kind
                  ? {
                      name: kind.fixedAllowance.name,
                      maximum: kind.fixedAllowance.limit,
                    }
                  : { name: kind.name, maximum: kind.maximum },
              ...field,
            },
      cause === undefined ? undefined : { cause },
    );
    this.name = "CaptureFormatError";
    this.ceiling =
      typeof kind === "object" && "fixedAllowance" in kind ? kind : undefined;
  }

  /** The reader-named fixed ceiling, for a limit that is not a capture budget. */
  readonly ceiling: CaptureFixedCeiling | undefined;

  /** JSON pointer of the failing capture value; empty for the whole input. */
  get pointer(): string {
    return this.failure.field ?? "";
  }

  /** The exhausted capture budget, for a `limit` failure that is not a fixed ceiling. */
  get limit():
    | { readonly name: CaptureLimitName; readonly maximum: number }
    | undefined {
    return this.failure.kind === "limit" && this.ceiling === undefined
      ? {
          name: this.failure.limit.name as CaptureLimitName,
          maximum: this.failure.limit.maximum,
        }
      : undefined;
  }

  /** The reason a decoder child reports for this failure on the reply wire. */
  get replyReason():
    | "format"
    | "unsupported"
    | "decoder"
    | "input-limit"
    | "expanded-limit"
    | "fixed-limit" {
    if (this.ceiling !== undefined) return "fixed-limit";
    const { limit } = this;
    if (limit === undefined)
      return this.failure.kind === "unsupported" ? "unsupported" : "format";
    return CAPTURE_LIMITS[limit.name].reply ?? "decoder";
  }
}
