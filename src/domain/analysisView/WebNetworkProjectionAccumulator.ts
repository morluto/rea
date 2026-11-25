import { z } from "zod";
import { Budget } from "../budget.js";
import { fixedAllowanceOptions } from "../fixedAllowanceRemediation.js";
import {
  AnalysisResourceConstraintError,
  unsupportedTarget,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import { err, ok, type Result } from "../result.js";
import {
  safeParseOwnedWebNetworkCapture,
  type WebNetworkCapture,
} from "../webNetworkCapture.js";
import { admitAnalysisViewData } from "./analysisViewDataAdmission.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ENTRY_BYTES,
  textBytes,
  type Reserve,
} from "./webNetworkRouteTemplates.js";
import { evidenceFileTarget } from "../evidence.js";

/** Shared retained/temporary byte accounting for views that group retained HAR records. */
export abstract class WebNetworkProjectionAccumulator {
  readonly #limitations = new Set<string>();
  /** Retained state and temporary work share one allowance. */
  readonly #bytes: Budget;
  /** The retained and temporary shares of `#bytes`, for their checkpoints. */
  readonly #retained: Budget;
  readonly #temporary: Budget;
  /** Per-record scratch reservation handed to the shared record readers. */
  protected readonly scratch: Reserve = (bytes) => this.temporary(bytes);

  protected constructor(
    readonly maximumBytes: number,
    private readonly budgetSubject: string,
    private readonly operation = "inspect_analysis_view",
  ) {
    this.#bytes = new Budget(maximumBytes);
    this.#retained = new Budget(maximumBytes);
    this.#temporary = new Budget(maximumBytes);
  }

  #charge(share: Budget, bytes: number): boolean {
    if (!this.#bytes.tryCharge(bytes)) return false;
    // A share never exceeds the whole, so it always fits.
    return share.tryCharge(bytes);
  }

  #restore(share: Budget, mark: number): void {
    this.#bytes.refund(share.restore(mark));
  }

  protected retain(bytes: number): boolean {
    return this.#charge(this.#retained, bytes);
  }

  protected temporary(bytes: number): boolean {
    return this.#charge(this.#temporary, bytes);
  }

  /**
   * Release the scratch charged by a nested body lease. Leases end in LIFO
   * order and `releaseTemporary` never runs inside one, so the enclosing
   * parse's scratch is still charged when this runs.
   */
  protected temporaryCheckpoint(): () => void {
    const mark = this.#temporary.used;
    return () => {
      this.#restore(this.#temporary, mark);
    };
  }

  /** Mark the retained bytes; the returned call releases what was retained since, once none of it is held. */
  protected retainedCheckpoint(): () => void {
    const mark = this.#retained.used;
    return () => {
      this.#restore(this.#retained, mark);
    };
  }

  /** Per-record strings and descriptors never become cumulative scratch. */
  protected releaseTemporary(): void {
    this.#restore(this.#temporary, 0);
  }

  protected overBudget(): Result<never, AnalysisError> {
    return err(
      new AnalysisResourceConstraintError(
        this.operation,
        "memory",
        `${this.budgetSubject} retained state and temporary work exceed the projection representation budget.`,
        { output_bytes: this.maximumBytes },
        fixedAllowanceOptions(
          "The analysis-view projection allowance",
          "parser",
          { limit: this.maximumBytes, unit: "bytes" },
        ),
      ),
    );
  }

  /** Reserve schema output and validation scratch while the borrowed parent stays live. */
  admitCaptureClone(value: unknown): Result<void, AnalysisError> {
    return admitAnalysisViewData(value, false, (bytes) =>
      this.retain(bytes) ? ok(undefined) : this.overBudget(),
    );
  }

  /** Reserve bytes a view derives from the borrowed parent before it allocates them. */
  admitDerivedBytes(bytes: number): Result<void, AnalysisError> {
    return this.retain(bytes) ? ok(undefined) : this.overBudget();
  }

  /** Admit the complete portable envelope before cloning or authenticating it. */
  admitInlineEvidence(value: unknown): Result<void, AnalysisError> {
    return admitAnalysisViewData(value, true, (bytes) =>
      this.retain(bytes) ? ok(undefined) : this.overBudget(),
    );
  }

  addLimitations(limitations: readonly string[]): Result<void, AnalysisError> {
    const prepared = this.prepareLimitations(limitations);
    if (!prepared.ok) return prepared;
    prepared.value();
    return ok(undefined);
  }

  /** Admit record qualifications without publishing them before the record commits. */
  protected prepareLimitations(
    limitations: readonly string[],
  ): Result<() => void, AnalysisError> {
    const rollbackAdmission = this.retainedCheckpoint();
    const pending = new Set<string>();
    for (const limitation of limitations) {
      if (this.#limitations.has(limitation) || pending.has(limitation))
        continue;
      if (!this.retain(ENTRY_BYTES + textBytes(limitation.length))) {
        rollbackAdmission();
        return this.overBudget();
      }
      pending.add(limitation);
    }
    return ok(() => {
      for (const limitation of pending) this.#limitations.add(limitation);
    });
  }

  /** Derive budgeted qualifications for this snapshot without retaining old snapshots. */
  protected snapshotLimitations(
    derived: readonly string[],
  ): Result<string[], AnalysisError> {
    const release = this.temporaryCheckpoint();
    if (
      !this.scratch(
        derived.reduce(
          (bytes, limitation) =>
            bytes + ENTRY_BYTES + textBytes(limitation.length),
          0,
        ),
      )
    )
      return this.overBudget();
    try {
      return ok([...new Set([...this.#limitations, ...derived])].sort(compare));
    } finally {
      release();
    }
  }

  protected sortedLimitations(): string[] {
    return [...this.#limitations].sort(compare);
  }
}

/** Authenticate and gate a retained HAR parent before a grouping view reads any record. */
const parseHarCapture = (
  parent: AnalysisViewParent,
  operation: string,
  sourceField: string,
): Result<WebNetworkCapture, AnalysisError> => {
  const source = parent.normalizedResult;
  const parsed = safeParseOwnedWebNetworkCapture(source);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        operation,
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: [sourceField, "normalized_result", ...issue.path],
        })),
        { [sourceField]: { normalized_result: source } },
        { cause: parsed.error },
      ),
    );
  return ok(parsed.data);
};

export const admitHarCaptureParent = (
  parent: AnalysisViewParent,
  viewKind: "api-surface" | "environment-manifest" | "environment-state",
  accumulator: WebNetworkProjectionAccumulator,
  context: { readonly operation?: string; readonly sourceField?: string } = {},
): Result<WebNetworkCapture, AnalysisError> => {
  const operation = context.operation ?? "inspect_analysis_view";
  const sourceField = context.sourceField ?? "source";
  const unsupported = (reason: string) =>
    err(unsupportedTarget(operation, parent.evidenceId, "evidence", reason));
  if (parent.operation !== "inspect_web_network_capture")
    return unsupported(
      `View ${viewKind} is unsupported for parent operation ${parent.operation}; ${viewKind} requires ${viewKind === "api-surface" ? "inspect_web_network_capture" : "inspect_web_network_capture or capture_browser_scenario"}.`,
    );
  const admitted = accumulator.admitCaptureClone(parent.normalizedResult);
  if (!admitted.ok) return admitted;
  const parsed = parseHarCapture(parent, operation, sourceField);
  if (!parsed.ok) return parsed;
  if (parsed.value.format !== "har")
    return unsupported(
      `${viewKind} does not support capture format ${parsed.value.format}.`,
    );
  // Environment views preserve the recorded report path and authenticate its digest;
  // the api-surface view keeps the admission its existing callers rely on.
  const { artifact } = parsed.value;
  const subject = evidenceFileTarget(parent);
  if (
    viewKind !== "api-surface" &&
    artifact.sha256 !== null &&
    (subject == null || subject.sha256 !== artifact.sha256)
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message: "Capture parent subject must identify the report's SHA-256.",
        },
      ]),
    );
  // The view would write path templates it cannot check against declarations
  // the parent does not retain, so the refusal does not repeat declaration text.
  const declarations = z
    .object({ sensitive_value_count: z.number().int().nonnegative() })
    .safeParse(parent.parameters);
  if (!declarations.success || declarations.data.sensitive_value_count > 0)
    return err(
      unsupportedTarget(
        operation,
        parent.evidenceId,
        "evidence",
        "sensitive_values_unretained: this view cannot safely project this capture because sensitivity declarations are not retained. Use a compatible capture or summary view to inspect retained observations. Do not remove sensitivity declarations to bypass this restriction.",
        { field: "sensitive_value_count" },
      ),
    );
  return ok(parsed.value);
};
