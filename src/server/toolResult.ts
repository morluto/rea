import { constants as bufferConstants } from "node:buffer";

import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
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
  const text = serializeCandidate(candidate);
  // The transport serializes the candidate again as escaped text content and
  // again as structuredContent inside a single JSON-RPC message; every one of
  // those strings must individually fit the runtime's maximum string length.
  const embedded = text === null ? null : serializeCandidate(text);
  if (
    text === null ||
    embedded === null ||
    embedded.length + text.length + 4096 > bufferConstants.MAX_STRING_LENGTH
  )
    return transportConstraintResult(candidate, contract.name, text?.length);
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: candidate,
  };
};

/**
 * Stringify a candidate, treating only the single-string representation limit
 * as transport exhaustion; other serialization failures stay exceptional.
 */
const serializeCandidate = (candidate: JsonValue | string): string | null => {
  try {
    return JSON.stringify(candidate);
  } catch (error) {
    if (
      error instanceof RangeError &&
      error.message === "Invalid string length"
    )
      return null;
    throw error;
  }
};

/**
 * Report transport exhaustion with the retained Evidence identity so callers
 * can continue through evidence-scoped tools instead of losing the completed
 * analysis to an unqualified serialization exception.
 */
const transportConstraintResult = (
  candidate: JsonValue,
  operation: string,
  serializedCodeUnits: number | undefined,
): CallToolResult => {
  const evidenceId = evidenceIdOf(candidate);
  const error = new AnalysisResourceConstraintError(
    operation,
    "transport",
    `Result of ${operation} exceeds this runtime's single JSON-RPC string representation` +
      (evidenceId === null
        ? ""
        : `; the complete result remains retained as session Evidence ${evidenceId}`),
    {
      transport: "json-rpc-message",
      single_string_code_unit_limit: bufferConstants.MAX_STRING_LENGTH,
      serialized_code_units: serializedCodeUnits ?? null,
    },
  );
  const projected = projectAnalysisError(error);
  const structuredContent = {
    error: {
      ...projected,
      details: {
        ...projected.details,
        ...(evidenceId === null ? {} : { evidence_id: evidenceId }),
      },
    },
  };
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

const evidenceIdOf = (candidate: JsonValue): string | null =>
  typeof candidate === "object" &&
  candidate !== null &&
  !Array.isArray(candidate) &&
  typeof candidate.evidence_id === "string"
    ? candidate.evidence_id
    : null;

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
