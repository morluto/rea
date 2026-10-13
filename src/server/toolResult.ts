import type { CallToolResult } from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { Evidence } from "../domain/evidence.js";
import {
  INSPECT_ANALYSIS_VIEW_OPERATION,
  inspectAnalysisViewInputSchema,
} from "../domain/analysisView/analysisView.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  encodeToolResult,
  MCP_RESULT_STRING_LIMIT,
  TARGET_CONTENT_RESULT_META,
} from "./toolResultEncoding.js";

/** Create one delivery policy from the already selected, parsed response budget. */
export const createToolResultDelivery = (
  maximumResponseBytes: number | undefined,
): ToolResultDelivery =>
  new ToolResultDelivery(maximumResponseBytes ?? STDIO_DEFAULT_MAX_BUFFER_SIZE);

/** Offer a named, schema-validated source page only for retained native analysis. */
const nativeEvidenceContinuation = (
  evidence: Evidence,
): Readonly<Record<string, JsonValue>> => {
  if (evidence.operation !== "analyze_function") return {};
  const input = inspectAnalysisViewInputSchema.safeParse({
    source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
    view: { kind: "native", facet: "pseudocode", offset: 0 },
  });
  if (!input.success) return {};
  return {
    continuation: {
      name: INSPECT_ANALYSIS_VIEW_OPERATION,
      arguments: jsonValueSchema.parse(input.data),
    },
  };
};

/** Immutable encoding and recovery policy shared by one MCP server. */
export class ToolResultDelivery {
  readonly resultBudgetBytes: number;

  constructor(maximumResponseBytes: number) {
    this.resultBudgetBytes = maximumResponseBytes - 1024;
    Object.freeze(this);
  }

  /** Serialize a plain application result or its actionable error. */
  toCallToolResult(
    result: Result<JsonValue, AnalysisError>,
    contract: ToolContract,
  ): CallToolResult {
    return result.ok
      ? this.successResult(
          contract.kind === "session" ? { result: result.value } : result.value,
          contract,
        )
      : this.toErrorToolResult(result.error, contract.returnsTargetContent);
  }

  /** Deliver Evidence using the producer's explicit recording acknowledgment. */
  toEvidenceToolResult(
    evidence: Evidence,
    contract: ToolContract,
    recorded: Result<unknown, AnalysisError> | undefined,
  ): CallToolResult {
    return recorded !== undefined && !recorded.ok
      ? this.toErrorToolResult(recorded.error, contract.returnsTargetContent)
      : this.successResult(evidence, contract, {
          evidence_id: evidence.evidence_id,
          ...(recorded === undefined
            ? {}
            : {
                evidence_reference: {
                  kind: "retained-evidence",
                  evidence_id: evidence.evidence_id,
                },
                ...nativeEvidenceContinuation(evidence),
              }),
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
  ): CallToolResult {
    return this.projectedErrorResult(
      projectAnalysisError(error),
      targetContent,
    );
  }

  /** Deliver the original failure with the producer-acknowledged partial Evidence reference. */
  toRecordedPartialErrorToolResult(
    error: AnalysisError,
    evidenceId: string,
    recorded: Result<unknown, AnalysisError>,
    targetContent: boolean,
  ): CallToolResult {
    if (!recorded.ok) return this.toErrorToolResult(error, targetContent);
    const projected = projectAnalysisError(error);
    return this.projectedErrorResult(
      {
        ...projected,
        details: {
          ...projected.details,
          partial_observation: {
            kind: "retained-evidence",
            evidence_id: evidenceId,
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
    const structuredContent = { error: projected };
    // Errors reach the wire as text only; the structured copy is a private
    // carrier the transport removes after its own budget check.
    const encoded = encodeToolResult(
      structuredContent,
      this.resultBudgetBytes,
      "text",
      targetContent,
    );
    // The transport retains an oversized projected error before replacing it
    // with a recoverable delivery constraint, using this same budget.
    return {
      content: encoded.ok ? [{ type: "text", text: encoded.text }] : [],
      structuredContent,
      isError: true,
      ...(targetContent ? { _meta: TARGET_CONTENT_RESULT_META } : {}),
    };
  }

  private successResult(
    value: JsonValue,
    contract: ToolContract,
    recovery: Readonly<Record<string, JsonValue>> = {},
  ): CallToolResult {
    const encoded = encodeToolResult(
      value,
      this.resultBudgetBytes,
      "structured-and-text",
      contract.returnsTargetContent,
    );
    if (encoded.ok)
      return {
        content: [{ type: "text", text: encoded.text }],
        structuredContent: value,
        ...(contract.returnsTargetContent
          ? { _meta: TARGET_CONTENT_RESULT_META }
          : {}),
      };
    const retainedEvidence = recovery.evidence_reference !== undefined;
    const recoveryAdvice =
      recovery.continuation !== undefined
        ? "Call inspect_analysis_view with the supplied continuation arguments to read retained pseudocode. Follow coverage.next_offset for subsequent pages; reduce the page limit if needed, or export the complete retained Evidence."
        : retainedEvidence
          ? "Export retained evidence to consume the complete analysis, or use complete CLI JSON output."
          : encoded.constraint === "string-length"
            ? "Use complete CLI JSON output to consume the analysis."
            : "Use a larger MCP response budget with a matching client receive buffer, or use complete CLI JSON output to consume the analysis.";
    return this.toErrorToolResult(
      new AnalysisResourceConstraintError(
        contract.name,
        "transport",
        encoded.constraint === "string-length"
          ? `The operation completed, but its complete MCP response exceeds Node's single-string representation limit. ${recoveryAdvice}`
          : `The operation completed, but its complete MCP response exceeds the stdio response budget. The analysis result was not truncated. ${recoveryAdvice}`,
        {
          boundary: "mcp-response",
          default_receive_buffer_bytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
          result_budget_bytes: this.resultBudgetBytes,
          max_string_code_units: MCP_RESULT_STRING_LIMIT,
          response_bytes_at_least: encoded.bytesAtLeast,
          response_code_units_at_least: encoded.codeUnitsAtLeast,
          constraint: encoded.constraint,
          ...recovery,
        },
        recovery.continuation === undefined
          ? undefined
          : { remediationAction: recoveryAdvice },
      ),
      contract.returnsTargetContent,
    );
  }
}
