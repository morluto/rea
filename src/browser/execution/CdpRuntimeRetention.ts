import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { Budget } from "../../domain/budget.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { WEB_RUNTIME_LIMITS } from "../../domain/webRuntime.js";

type RuntimeRetentionKind = "metadata" | "requests" | "sources";

const retentionLimit = (kind: RuntimeRetentionKind): number =>
  kind === "sources"
    ? WEB_RUNTIME_LIMITS.sourceBytes
    : WEB_RUNTIME_LIMITS.retainedEventBytes;

const retentionExceeded = (
  operation: string,
  kind: RuntimeRetentionKind,
  retainedBytes: number,
): AnalysisResourceConstraintError => {
  const limit = retentionLimit(kind);
  const allowance = `Complete browser runtime ${kind} retention (${String(limit)} bytes)`;
  return new AnalysisResourceConstraintError(
    operation,
    "capacity",
    `${allowance} exceeded; no partial runtime result is returned.`,
    {
      boundary: "browser-runtime-retention",
      kind,
      retained_bytes: retainedBytes,
      limit_bytes: limit,
    },
    fixedAllowanceOptions(allowance, "live"),
  );
};

/** Enforce the retained runtime representation, separately from wire payloads. */
export const assertRuntimeRetention = (
  operation: string,
  kind: RuntimeRetentionKind,
  retainedBytes: number,
): void => {
  if (retainedBytes > retentionLimit(kind))
    throw retentionExceeded(operation, kind, retainedBytes);
};

/** Cumulative retention of one runtime kind across a capture. */
export class RuntimeRetention {
  readonly #bytes: Budget;

  constructor(
    readonly operation: string,
    readonly kind: RuntimeRetentionKind,
  ) {
    this.#bytes = new Budget(retentionLimit(kind));
  }

  /** Charge `bytes` before retaining them, or throw the retention failure. */
  charge(bytes: number): void {
    this.#bytes.charge(bytes, () =>
      retentionExceeded(this.operation, this.kind, this.#bytes.used + bytes),
    );
  }
}
