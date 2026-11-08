import { z } from "zod";
import { fixedAllowanceOptions } from "../fixedAllowanceRemediation.js";
import {
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
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

/** Shared retained/temporary byte accounting for views that group retained capture records. */
export abstract class WebNetworkProjectionAccumulator {
  readonly #limitations = new Set<string>();
  #retainedBytes = 0;
  #temporaryBytes = 0;
  /** Per-record scratch reservation handed to the shared record readers. */
  protected readonly scratch: Reserve = (bytes) => this.temporary(bytes);

  protected constructor(
    readonly maximumBytes: number,
    private readonly budgetSubject: string,
    private readonly operation = "inspect_analysis_view",
  ) {}

  protected retain(bytes: number): boolean {
    if (this.#retainedBytes + this.#temporaryBytes + bytes > this.maximumBytes)
      return false;
    this.#retainedBytes += bytes;
    return true;
  }

  protected temporary(bytes: number): boolean {
    if (this.#retainedBytes + this.#temporaryBytes + bytes > this.maximumBytes)
      return false;
    this.#temporaryBytes += bytes;
    return true;
  }

  /** Restore the enclosing synchronous parse's scratch after a nested body lease. */
  protected temporaryCheckpoint(): () => void {
    const held = this.#temporaryBytes;
    return () => {
      this.#temporaryBytes = held;
    };
  }

  /** Mark the retained bytes; the returned call releases what was retained since, once none of it is held. */
  protected retainedCheckpoint(): () => void {
    const mark = this.#retainedBytes;
    return () => {
      this.#retainedBytes = Math.min(this.#retainedBytes, mark);
    };
  }

  /** Per-record strings and descriptors never become cumulative scratch. */
  protected releaseTemporary(): void {
    this.#temporaryBytes = 0;
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
    for (const limitation of limitations) {
      if (this.#limitations.has(limitation)) continue;
      if (!this.retain(ENTRY_BYTES + textBytes(limitation.length)))
        return this.overBudget();
      this.#limitations.add(limitation);
    }
    return ok(undefined);
  }

  protected sortedLimitations(): string[] {
    return [...this.#limitations].sort(compare);
  }
}

/** Authenticate and gate a retained capture parent before a grouping view reads any record. */
export const admitWebNetworkCaptureParent = (
  parent: AnalysisViewParent,
  viewKind: "api-surface" | "environment-manifest" | "environment-state",
  accumulator: WebNetworkProjectionAccumulator,
  context: {
    readonly operation?: string;
    readonly sourceField?: string;
    readonly allowSaz?: boolean;
  } = {},
): Result<WebNetworkCapture & { format: "har" | "saz" }, AnalysisError> => {
  const operation = context.operation ?? "inspect_analysis_view";
  const sourceField = context.sourceField ?? "source";
  const unsupported = (reason: string, remediationAction?: string) =>
    err(
      new AnalysisUnsupportedTargetError(
        operation,
        parent.evidenceId,
        reason,
        remediationAction === undefined ? undefined : { remediationAction },
      ),
    );
  if (parent.operation !== "inspect_web_network_capture")
    return unsupported(
      `View ${viewKind} is unsupported for parent operation ${parent.operation}; ${viewKind} requires ${viewKind === "api-surface" ? "inspect_web_network_capture" : "inspect_web_network_capture or capture_browser_scenario"}.`,
    );
  const admitted = accumulator.admitCaptureClone(parent.normalizedResult);
  if (!admitted.ok) return admitted;
  const parsed = safeParseOwnedWebNetworkCapture(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        operation,
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: [sourceField, "normalized_result", ...issue.path],
        })),
        { [sourceField]: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  const { format } = parsed.data;
  if (
    (format !== "har" && format !== "saz") ||
    (format === "saz" &&
      (viewKind !== "api-surface" || context.allowSaz !== true))
  )
    return unsupported(
      `${viewKind} does not support capture format ${parsed.data.format}.`,
    );
  // Environment views preserve the recorded report path and authenticate its digest;
  // the api-surface view keeps the admission its existing callers rely on.
  const { artifact } = parsed.data;
  const subject = parent.subject;
  if (
    viewKind !== "api-surface" &&
    artifact.sha256 !== null &&
    (subject == null || subject.digest.sha256 !== artifact.sha256)
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
    return unsupported(
      "sensitive_values_unretained",
      "This view cannot safely project this capture because sensitivity declarations are not retained. Use a compatible capture or summary view to inspect retained observations. Do not remove sensitivity declarations to bypass this restriction.",
    );
  return ok({ ...parsed.data, format });
};
