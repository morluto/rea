import type { CallToolResult } from "@modelcontextprotocol/server";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import type { Evidence } from "../domain/evidence.js";
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
    : toErrorToolResult(result.error);

/** Deliver Evidence using the producer's explicit recording acknowledgment. */
export const toEvidenceToolResult = (
  evidence: Evidence,
  contract: ToolContract,
  recorded: Result<unknown, AnalysisError> | undefined,
): CallToolResult =>
  recorded !== undefined && !recorded.ok
    ? toErrorToolResult(recorded.error)
    : toCallToolResult(
        { ok: true, value: evidence },
        contract,
        recorded === undefined
          ? undefined
          : { retainedEvidenceId: evidence.evidence_id },
      );

/** Project an error without allocating oversized repeated MCP text. */
export const toErrorToolResult = (error: AnalysisError): CallToolResult => {
  const projected = projectAnalysisError(error);
  const structuredContent = { error: projected };
  const configured = parseMcpResponseBudget(
    process.env.REA_MCP_MAX_RESPONSE_BYTES,
  );
  const budget =
    configured.ok && configured.value !== undefined
      ? configured.value - 1024
      : MCP_RESULT_BUDGET_BYTES;
  const encoded = encodeToolResult(structuredContent, budget);
  // The session-bound transport retains an oversized projected error before
  // replacing it with a recoverable delivery constraint. Avoid allocating its
  // repeated text representation before that boundary has acknowledged it.
  return {
    content: encoded.ok ? [{ type: "text", text: encoded.text }] : [],
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
  if (!configured.ok) return toErrorToolResult(configured.error);
  const budget =
    configured.value === undefined
      ? MCP_RESULT_BUDGET_BYTES
      : configured.value - 1024;
  const encoded = encodeToolResult(candidate, budget);
  if (!encoded.ok)
    return toErrorToolResult(
      new AnalysisResourceConstraintError(
        contract.name,
        "transport",
        encoded.constraint === "string-length"
          ? "The operation completed, but its complete MCP response exceeds Node's single-string representation limit. Export retained evidence to consume the complete analysis, or use complete CLI JSON output."
          : "The operation completed, but its complete MCP response exceeds the stdio response budget. The analysis result was not truncated; export retained evidence to consume it, or use complete CLI JSON output.",
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
