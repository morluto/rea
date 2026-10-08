import type { CallToolResult } from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import {
  encodeToolResult,
  MCP_RESULT_BUDGET_BYTES,
  MCP_RESULT_STRING_LIMIT,
} from "./toolResultEncoding.js";

/**
 * Serialize an application result as MCP text and structured content.
 * Shared error projection preserves actionable local diagnostics while omitting
 * raw cause objects; explicitly retained bounded command output stays visible.
 */
export const toCallToolResult = (
  result: Result<JsonValue, AnalysisError>,
  contract: ToolContract,
  context?: { readonly retainedEvidenceId: string },
): CallToolResult =>
  result.ok
    ? successResult(result.value, contract, context)
    : errorResult(result.error);

const errorResult = (error: AnalysisError): CallToolResult => {
  const projected = projectAnalysisError(error);
  const structuredContent = { error: projected };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    isError: true,
  };
};

const successResult = (
  value: JsonValue,
  contract: ToolContract,
  context: { readonly retainedEvidenceId: string } | undefined,
): CallToolResult => {
  const candidate =
    projectEvidence(value) ??
    (contract.kind === "session" ? { result: value } : value);
  const configured = parseMcpResponseBudget(
    process.env.REA_MCP_MAX_RESPONSE_BYTES,
  );
  if (!configured.ok) return errorResult(configured.error);
  const budget =
    configured.value === undefined
      ? MCP_RESULT_BUDGET_BYTES
      : configured.value - 1024;
  const encoded = encodeToolResult(candidate, budget);
  if (!encoded.ok)
    return errorResult(
      new AnalysisResourceConstraintError(
        contract.name,
        "transport",
        encoded.constraint === "string-length"
          ? "The complete MCP response exceeds Node's single-string representation limit. Use a focused retained-Evidence query or export to consume the complete analysis."
          : "The complete MCP response exceeds the stdio response budget. The analysis result was not truncated; use a focused retained-Evidence query or export to consume it.",
        {
          boundary: "mcp-response",
          default_receive_buffer_bytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
          result_budget_bytes: budget,
          max_string_code_units: MCP_RESULT_STRING_LIMIT,
          response_bytes_at_least: encoded.bytesAtLeast,
          response_code_units_at_least: encoded.codeUnitsAtLeast,
          constraint: encoded.constraint,
          ...evidenceRecovery(value, context?.retainedEvidenceId),
        },
      ),
    );
  return {
    content: [
      {
        type: "text",
        text: encoded.text,
      },
    ],
    structuredContent: candidate,
  };
};

const evidenceRecovery = (
  value: JsonValue,
  retainedEvidenceId: string | undefined,
): Record<string, JsonValue> => {
  const projected = projectEvidence(value);
  if (
    projected === undefined ||
    typeof projected !== "object" ||
    projected === null ||
    Array.isArray(projected)
  )
    return {};
  if (projected.evidence_id !== retainedEvidenceId)
    return { evidence_id: projected.evidence_id ?? null };
  return {
    evidence_reference: {
      kind: "retained-evidence",
      evidence_id: projected.evidence_id ?? null,
    },
  };
};

const projectEvidence = (value: JsonValue): JsonValue | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.evidence_id !== "string" ||
    !/^ev_[a-f0-9]{64}$/u.test(value.evidence_id) ||
    !("normalized_result" in value)
  )
    return undefined;
  const normalizedResult = value.normalized_result;
  const evidenceId = value.evidence_id;
  if (normalizedResult === undefined || typeof evidenceId !== "string")
    return undefined;
  return {
    result: normalizedResult,
    evidence_id: evidenceId,
    evidence: value,
  };
};
