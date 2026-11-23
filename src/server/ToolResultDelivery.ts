import type { CallToolResult } from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { Evidence } from "../domain/evidence.js";
import { safeParseEvidence } from "../domain/evidenceValidation.js";
import {
  omitUnretainedEvidenceFromError,
  projectAnalysisError,
  projectAnalysisErrorWithoutPartialObservation,
  unretainedEvidenceCandidates,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { NoBinaryOpenError } from "../domain/configurationErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  MCP_TRANSPORT_EVIDENCE_DISCOVERY,
  MCP_TRANSPORT_EVIDENCE_LINKS,
  MCP_TRANSPORT_EVIDENCE_RECORDS,
  MCP_TRANSPORT_EVIDENCE_SUMMARY,
} from "../domain/analysisErrorPresentation.js";
import {
  nodeStringCeilingRecovery,
  stdioResponseBudgetRecovery,
} from "../config/mcpResponseBudget.js";
import {
  encodeToolResult,
  errorTextWireBytes,
  measureMcpResultWithinBudget,
  MCP_RESULT_STRING_LIMIT,
  NODE_MAX_STRING_LENGTH,
  TARGET_CONTENT_RESULT_META,
  type ToolResultEncoding,
} from "./toolResultEncoding.js";
import { isRecord } from "../kernel/isRecord.js";

/** Project a response-budget refusal without labeling REA's reserved string limit as Node's ceiling. */
export const mcpResponseOverflowProjection = (input: {
  readonly completed: boolean;
  readonly constraint: "receive-buffer" | "string-length";
  readonly effectiveResponseBytes: number;
  readonly nextStep: string;
}): { readonly reason: string; readonly remediationAction: string } => {
  const facts =
    input.constraint === "string-length"
      ? nodeStringCeilingRecovery(
          MCP_RESULT_STRING_LIMIT,
          NODE_MAX_STRING_LENGTH,
        )
      : stdioResponseBudgetRecovery(
          input.effectiveResponseBytes,
          MCP_RESULT_STRING_LIMIT,
          NODE_MAX_STRING_LENGTH,
        );
  const summary =
    input.constraint === "string-length"
      ? input.completed
        ? "The operation completed, but its complete MCP response exceeds REA's reserved single-string limit."
        : "The tool failed, but its complete error response exceeds REA's reserved single-string limit."
      : input.completed
        ? "The operation completed, but its complete MCP response exceeds the stdio response budget. The analysis result was not truncated."
        : "The tool failed, but its complete error response exceeds the MCP response budget.";
  return {
    reason: `${summary} ${facts} ${input.nextStep}`,
    remediationAction: `${input.nextStep} ${facts}`,
  };
};

/**
 * The bundle projection a get_evidence_bundle result already selected.
 * Each projection owns a different next step when it exceeds one MCP frame.
 */
const evidenceBundleProjection = (value: JsonValue): JsonValue | undefined => {
  const payload = isRecord(value) && "result" in value ? value.result : value;
  return isRecord(payload) ? payload.kind : undefined;
};

/**
 * The recovery for an overflowing completed result: its prose and, when it
 * names one MCP operation to call first, that operation. The CLI fallback
 * names none.
 */
interface OverflowNextStep {
  readonly text: string;
  readonly operation?: string;
}

const evidenceBundleOverflowStep = (value: JsonValue): OverflowNextStep => {
  const projection = evidenceBundleProjection(value);
  if (projection === "evidence-bundle-summary")
    return {
      text: MCP_TRANSPORT_EVIDENCE_SUMMARY,
      operation: "get_evidence_bundle",
    };
  return {
    text:
      projection === "evidence-link-inspection"
        ? MCP_TRANSPORT_EVIDENCE_LINKS
        : projection === "evidence-record-selection"
          ? MCP_TRANSPORT_EVIDENCE_RECORDS
          : MCP_TRANSPORT_EVIDENCE_DISCOVERY,
    operation: "get_evidence_bundle",
  };
};

/**
 * Rows in an overflowing `list_unknowns` page, delivered as a session
 * `{ result }` envelope; a smaller limit only helps above one.
 */
const unknownPageItems = (value: JsonValue): number => {
  const page = isRecord(value) ? value.result : undefined;
  return isRecord(page) && Array.isArray(page.items)
    ? page.items.length
    : Number.POSITIVE_INFINITY;
};

const overflowNextStep = (
  value: JsonValue,
  contract: ToolContract,
  recovery: Readonly<Record<string, JsonValue>>,
): OverflowNextStep => {
  if (recovery.committed_unknown !== undefined)
    return {
      text: "Export this session with export_evidence_bundle to inspect the committed unknown and its mutation Evidence. Do not repeat the completed mutation; an individual unknown may be too large for a list_unknowns page.",
      operation: "export_evidence_bundle",
    };
  if (recovery.continuation !== undefined)
    return {
      text: "Call inspect_analysis_view with the supplied continuation arguments to read retained analysis. Follow coverage.next_offset for subsequent pages; reduce the page limit if needed, or export the complete retained Evidence.",
      operation: "inspect_analysis_view",
    };
  if (recovery.evidence_reference !== undefined)
    return {
      text: "Export retained evidence to consume the complete analysis, or use complete CLI JSON output.",
      operation: "export_evidence_bundle",
    };
  if (contract.name === "list_unknowns" && unknownPageItems(value) <= 1)
    return {
      text: "One unknown does not fit a list_unknowns response on this connection, so a smaller limit cannot help. Export the session with export_evidence_bundle to recover it.",
      operation: "export_evidence_bundle",
    };
  if (contract.name === "list_unknowns")
    return {
      text: "Call list_unknowns on this same connection with the same filters and offset, using a smaller limit, then follow next_offset. If a single unknown cannot fit, export the session with export_evidence_bundle to recover it.",
      operation: "list_unknowns",
    };
  if (contract.name === "get_evidence_bundle")
    return evidenceBundleOverflowStep(value);
  if (contract.name === "inspect_address_context")
    return {
      text: "Call get_evidence_bundle with detail summary to discover retained facet observations, then export_evidence_bundle to inspect complete records. Some facets may not have been retained; a new analysis can differ.",
      operation: "get_evidence_bundle",
    };
  return { text: "Use complete CLI JSON output to consume the analysis." };
};

/** Immutable encoding and recovery policy shared by one MCP server. */
/** The encoding already computed by `ToolResultDelivery` for a structured error result. */
export interface ProjectedErrorEncoding {
  readonly budgetBytes: number;
  readonly targetContent: boolean;
  readonly text: string;
}

const projectedErrorEncodings = new WeakMap<object, ProjectedErrorEncoding>();

/** Return the `ToolResultDelivery` encoding stamped on this exact error result, if any. */
export const projectedErrorEncoding = (
  result: object,
): ProjectedErrorEncoding | undefined => projectedErrorEncodings.get(result);

export class ToolResultDelivery {
  readonly maximumResponseBytes: number;
  readonly resultBudgetBytes: number;
  constructor(
    maximumResponseBytes: number,
    private readonly nativeContinuation: (
      evidence: Evidence,
      selected?: JsonValue,
      viewSource?: JsonValue,
    ) => Readonly<Record<string, JsonValue>> = () => ({}),
    private readonly noTargetRecovery?: string,
  ) {
    this.maximumResponseBytes = maximumResponseBytes;
    this.resultBudgetBytes = maximumResponseBytes - 1024;
    Object.freeze(this);
  }

  /** Bind scope-specific recovery without mutating a shared delivery policy. */
  withNoTargetRecovery(recovery: string): ToolResultDelivery {
    return new ToolResultDelivery(
      this.maximumResponseBytes,
      this.nativeContinuation,
      recovery,
    );
  }

  /** Serialize a plain application result or its actionable error. */
  toCallToolResult(
    result: Result<JsonValue, AnalysisError>,
    contract: ToolContract,
    recovery: Readonly<Record<string, JsonValue>> = {},
    alternatives?: (
      failure: Extract<ToolResultEncoding, { readonly ok: false }>,
      budgetBytes: number,
    ) => Iterable<JsonValue>,
  ): CallToolResult {
    // A session tool's result is delivered inside `result`, alternatives too.
    const shaped = (value: JsonValue): JsonValue =>
      contract.kind === "session" ? { result: value } : value;
    return result.ok
      ? this.successResult(
          shaped(result.value),
          contract,
          recovery,
          alternatives === undefined
            ? undefined
            : function* (failure, budgetBytes) {
                for (const alternative of alternatives(failure, budgetBytes))
                  yield shaped(alternative);
              },
        )
      : this.toErrorToolResult(result.error, contract.returnsTargetContent);
  }

  /**
   * A plain result followed by the content blocks a forwarded tool returned,
   * such as a computer's screenshot, unchanged. When the whole response does
   * not fit the budget, the error keeps the tool's own result, whose ids name
   * what it started, and says how to ask for a smaller image.
   */
  toForwardedToolResult(
    result: Result<JsonValue, AnalysisError>,
    contract: ToolContract,
    forwarded: readonly Readonly<Record<string, JsonValue>>[],
  ): CallToolResult {
    const delivered = this.toCallToolResult(result, contract);
    if (delivered.isError === true || forwarded.length === 0) return delivered;
    // The blocks are the upstream MCP result's own, validated by its client.
    const content = [
      ...delivered.content,
      ...(forwarded as CallToolResult["content"]),
    ];
    const combined = { ...delivered, content };
    const measured = measureMcpResultWithinBudget(
      combined,
      this.resultBudgetBytes,
    );
    if (measured.ok) return combined;
    const projected = mcpResponseOverflowProjection({
      completed: true,
      constraint: "receive-buffer",
      effectiveResponseBytes: this.maximumResponseBytes,
      nextStep:
        "The tool's own result, without the forwarded content, is details.result; use its ids, and ask for a smaller image: a screenshot region, or format jpeg with a lower quality.",
    });
    return this.toErrorToolResult(
      new AnalysisResourceConstraintError(
        contract.name,
        "transport",
        projected.reason,
        {
          boundary: "mcp-response",
          result_budget_bytes: this.resultBudgetBytes,
          response_bytes_at_least: measured.bytesAtLeast,
          constraint: measured.constraint,
        },
        { remediationAction: projected.remediationAction },
      ),
      contract.returnsTargetContent,
      { result: result.ok ? result.value : null },
    );
  }

  /** Deliver Evidence using the producer's explicit recording acknowledgment. */
  toEvidenceToolResult(
    evidence: Evidence,
    contract: ToolContract,
    recorded: Result<unknown, AnalysisError> | undefined,
    viewSource?: JsonValue | (() => JsonValue | undefined),
  ): CallToolResult {
    return recorded !== undefined && !recorded.ok
      ? this.toErrorToolResult(recorded.error, contract.returnsTargetContent)
      : this.successResult(evidence, contract, () => {
          const resolvedViewSource =
            typeof viewSource === "function" ? viewSource() : viewSource;
          return {
            evidence_id: evidence.evidence_id,
            ...(recorded === undefined
              ? {}
              : {
                  evidence_reference: {
                    kind: "retained-evidence",
                    evidence_id: evidence.evidence_id,
                  },
                }),
            // A view names its caller's source, which needs no session to read again.
            ...(recorded === undefined && resolvedViewSource === undefined
              ? {}
              : this.nativeContinuation(
                  evidence,
                  undefined,
                  resolvedViewSource,
                )),
          };
        });
  }

  /**
   * Deliver a caller-selected view of an already retained parent. Overflow
   * recovery names that parent and a smaller page of the same selection,
   * since the view record itself is not an analysis-view parent.
   */
  toSelectedViewToolResult(
    view: Evidence,
    selection: { readonly parent: Evidence; readonly request: JsonValue },
    contract: ToolContract,
    recorded: Result<unknown, AnalysisError> | undefined,
  ): CallToolResult {
    return recorded !== undefined && !recorded.ok
      ? this.toErrorToolResult(recorded.error, contract.returnsTargetContent)
      : this.successResult(view, contract, {
          evidence_id: view.evidence_id,
          evidence_reference: {
            kind: "retained-evidence",
            evidence_id: selection.parent.evidence_id,
          },
          ...this.nativeContinuation(selection.parent, selection.request),
        });
  }

  /**
   * Project an error without allocating oversized repeated MCP text.
   * `targetContent` is the failing tool's `returnsTargetContent`: a failure
   * can carry target-derived text (a message, captured output, or a partial
   * observation), so it is marked exactly like that tool's successful results.
   */
  toErrorToolResult(
    error: AnalysisError,
    targetContent: boolean,
    details?: Readonly<Record<string, JsonValue>>,
  ): CallToolResult {
    const base = projectAnalysisError(error);
    const projected =
      details === undefined
        ? base
        : { ...base, details: { ...base.details, ...details } };
    if (
      error instanceof NoBinaryOpenError &&
      this.noTargetRecovery !== undefined
    )
      return this.projectedErrorResult(
        {
          ...projected,
          message: this.noTargetRecovery,
          remediation: { action: this.noTargetRecovery },
        },
        targetContent,
      );
    return this.projectedErrorResult(projected, targetContent);
  }

  /**
   * Deliver an error with facts its operation observed alongside it (an
   * open's selection at failure, say) added to the error's own details.
   */
  toDetailedErrorToolResult(
    error: AnalysisError,
    details: Readonly<Record<string, JsonValue>>,
    targetContent: boolean,
  ): CallToolResult {
    const projected = projectAnalysisError(error);
    return this.projectedErrorResult(
      { ...projected, details: { ...projected.details, ...details } },
      targetContent,
    );
  }

  /** Retain valid partial Evidence and reference it only after recording succeeds. */
  toPartialErrorToolResult(
    error: AnalysisError,
    targetContent: boolean,
    recordEvidence?: EvidenceWriter["recordEvidence"],
  ): CallToolResult {
    if (recordEvidence === undefined)
      return this.toErrorToolResult(error, targetContent);
    const partial = safeParseEvidence(error.partialObservation);
    if (!partial.ok) return this.toErrorToolResult(error, targetContent);
    const recorded = recordEvidence(partial.value);
    const projected = projectAnalysisError(error);
    if (!recorded.ok)
      return this.projectedErrorResult(
        {
          ...projected,
          details: {
            ...projected.details,
            // The ledger states whether the record is already retained; only
            // without that fact is retention unknown.
            partial_observation: ledgerRetentionFact(
              recorded.error.partialObservation,
              partial.value,
            ) ?? {
              kind: "inline-evidence",
              retention: "unknown",
              evidence: partial.value,
            },
            retention_error: projectAnalysisErrorWithoutPartialObservation(
              recorded.error,
            ),
          },
        },
        targetContent,
      );
    return this.projectedErrorResult(
      {
        ...projected,
        details: {
          ...projected.details,
          partial_observation: {
            kind: "retained-evidence",
            evidence_id: partial.value.evidence_id,
          },
        },
      },
      targetContent,
    );
  }

  private projectedErrorResult(
    projected: AnalysisErrorProjection,
    targetContent: boolean,
  ): CallToolResult {
    let structuredContent = { error: projected };
    // Errors reach the wire as text only; the structured copy is a private
    // carrier the transport removes after its own budget check.
    let encoded = encodeToolResult(
      structuredContent,
      this.resultBudgetBytes,
      "error-text",
      targetContent,
    );
    if (!encoded.ok) {
      let candidateProjection = projected;
      const rawCandidates = [
        ...unretainedEvidenceCandidates(candidateProjection),
      ];
      const remaining =
        rawCandidates.length <= 1
          ? rawCandidates
          : rawCandidates
              .map((candidate) => ({
                candidate,
                size: errorTextWireBytes(
                  candidate.value,
                  this.resultBudgetBytes,
                ),
              }))
              .sort((left, right) => right.size - left.size)
              .map(({ candidate }) => candidate);
      let index = 0;
      while (!encoded.ok && index < remaining.length) {
        const compact = omitUnretainedEvidenceFromError(
          candidateProjection,
          encoded,
          remaining[index]!,
        );
        index += 1;
        if (compact === undefined) continue;
        candidateProjection = compact;
        const content = { error: compact };
        const compactEncoded = encodeToolResult(
          content,
          this.resultBudgetBytes,
          "error-text",
          targetContent,
        );
        if (compactEncoded.ok) {
          structuredContent = content;
          encoded = compactEncoded;
          break;
        }
      }
    }
    // The transport retains an oversized projected error before replacing it
    // with a recoverable delivery constraint, using this same budget.
    const result: CallToolResult = {
      content: encoded.ok ? [{ type: "text", text: encoded.text }] : [],
      structuredContent,
      isError: true,
      ...(targetContent ? { _meta: TARGET_CONTENT_RESULT_META } : {}),
    };
    if (encoded.ok)
      projectedErrorEncodings.set(result, {
        budgetBytes: this.resultBudgetBytes,
        targetContent,
        text: encoded.text,
      });
    return result;
  }

  private successResult(
    value: JsonValue,
    contract: ToolContract,
    recovery:
      | Readonly<Record<string, JsonValue>>
      | (() => Readonly<Record<string, JsonValue>>) = {},
    alternatives?: (
      failure: Extract<ToolResultEncoding, { readonly ok: false }>,
      budgetBytes: number,
    ) => Iterable<JsonValue>,
  ): CallToolResult {
    let encoded = encodeToolResult(
      value,
      this.resultBudgetBytes,
      "structured-and-text",
      contract.returnsTargetContent,
    );
    if (!encoded.ok && alternatives !== undefined)
      for (const candidate of alternatives(encoded, this.resultBudgetBytes)) {
        const candidateEncoding = encodeToolResult(
          candidate,
          this.resultBudgetBytes,
          "structured-and-text",
          contract.returnsTargetContent,
        );
        if (candidateEncoding.ok) {
          value = candidate;
          encoded = candidateEncoding;
          break;
        }
      }
    if (encoded.ok)
      return {
        content: [{ type: "text", text: encoded.text }],
        structuredContent: value,
        ...(contract.returnsTargetContent
          ? { _meta: TARGET_CONTENT_RESULT_META }
          : {}),
      };
    const resolvedRecovery =
      typeof recovery === "function" ? recovery() : recovery;
    const nextStep = overflowNextStep(value, contract, resolvedRecovery);
    const projected = mcpResponseOverflowProjection({
      completed: true,
      constraint: encoded.constraint,
      effectiveResponseBytes: this.maximumResponseBytes,
      nextStep: nextStep.text,
    });
    return this.toErrorToolResult(
      new AnalysisResourceConstraintError(
        contract.name,
        "transport",
        projected.reason,
        {
          boundary: "mcp-response",
          default_receive_buffer_bytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
          result_budget_bytes: this.resultBudgetBytes,
          max_string_code_units: MCP_RESULT_STRING_LIMIT,
          response_bytes_at_least: encoded.bytesAtLeast,
          response_code_units_at_least: encoded.codeUnitsAtLeast,
          constraint: encoded.constraint,
          ...resolvedRecovery,
          ...(nextStep.operation === undefined
            ? {}
            : { next_operation: nextStep.operation }),
        },
        { remediationAction: projected.remediationAction },
      ),
      contract.returnsTargetContent,
    );
  }
}

/** The ledger's own retained/unretained fact for this exact record, if it gave one. */
const ledgerRetentionFact = (
  fact: unknown,
  evidence: Evidence,
):
  | { readonly kind: "retained-evidence"; readonly evidence_id: string }
  | { readonly kind: "unretained-evidence"; readonly evidence: Evidence }
  | undefined => {
  if (typeof fact !== "object" || fact === null) return undefined;
  const value = fact as {
    readonly kind?: unknown;
    readonly evidence_id?: unknown;
  };
  if (
    value.kind === "retained-evidence" &&
    value.evidence_id === evidence.evidence_id
  )
    return { kind: "retained-evidence", evidence_id: evidence.evidence_id };
  if (value.kind === "unretained-evidence")
    return { kind: "unretained-evidence", evidence };
  return undefined;
};
