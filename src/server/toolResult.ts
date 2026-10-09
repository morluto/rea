import type { CallToolResult } from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import type { Evidence } from "../domain/evidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  encodeToolResult,
  MCP_RESULT_STRING_LIMIT,
} from "./toolResultEncoding.js";

/** Create one delivery policy from the already selected, parsed response budget. */
export const createToolResultDelivery = (
  maximumResponseBytes: number | undefined,
): ToolResultDelivery =>
  new ToolResultDelivery(maximumResponseBytes ?? STDIO_DEFAULT_MAX_BUFFER_SIZE);

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
      : this.toErrorToolResult(result.error);
  }

  /** Deliver Evidence using the producer's explicit recording acknowledgment. */
  toEvidenceToolResult(
    evidence: Evidence,
    contract: ToolContract,
    recorded: Result<unknown, AnalysisError> | undefined,
  ): CallToolResult {
    return recorded !== undefined && !recorded.ok
      ? this.toErrorToolResult(recorded.error)
      : this.successResult(evidence, contract, {
          evidence_id: evidence.evidence_id,
          ...(recorded === undefined
            ? {}
            : {
                evidence_reference: {
                  kind: "retained-evidence",
                  evidence_id: evidence.evidence_id,
                },
              }),
        });
  }

  /** Project an error without allocating oversized repeated MCP text. */
  toErrorToolResult(error: AnalysisError): CallToolResult {
    const structuredContent = { error: projectAnalysisError(error) };
    const encoded = encodeToolResult(structuredContent, this.resultBudgetBytes);
    // The transport retains an oversized projected error before replacing it
    // with a recoverable delivery constraint, using this same budget.
    return {
      content: encoded.ok ? [{ type: "text", text: encoded.text }] : [],
      structuredContent,
      isError: true,
    };
  }

  private successResult(
    value: JsonValue,
    contract: ToolContract,
    recovery: Readonly<Record<string, JsonValue>> = {},
  ): CallToolResult {
    const encoded = encodeToolResult(value, this.resultBudgetBytes);
    if (!encoded.ok)
      return this.toErrorToolResult(
        new AnalysisResourceConstraintError(
          contract.name,
          "transport",
          encoded.constraint === "string-length"
            ? "The operation completed, but its complete MCP response exceeds Node's single-string representation limit. Export retained evidence to consume the complete analysis, or use complete CLI JSON output."
            : "The operation completed, but its complete MCP response exceeds the stdio response budget. The analysis result was not truncated; export retained evidence to consume it, or use complete CLI JSON output.",
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
        ),
      );
    return {
      content: [{ type: "text", text: encoded.text }],
      structuredContent: value,
    };
  }
}
