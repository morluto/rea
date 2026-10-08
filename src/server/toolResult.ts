import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

/**
 * Serialize an application result as MCP text and structured content.
 * Shared error projection preserves actionable local diagnostics while omitting
 * raw cause objects; explicitly retained bounded command output stays visible.
 */
export const toCallToolResult = (
  result: Result<JsonValue, AnalysisError>,
  contract: ToolContract,
): CallToolResult =>
  result.ok ? successResult(result.value, contract) : errorResult(result.error);

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
): CallToolResult => {
  const candidate =
    projectEvidence(value) ??
    (contract.kind === "session" ? { result: value } : value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(candidate),
      },
    ],
    structuredContent: candidate,
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
