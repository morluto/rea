import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  AnalysisOutputError,
  projectAnalysisError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ToolContract } from "../contracts/toolContracts.js";

interface ToolResultOptions {
  readonly evidenceResourcesAvailable?: boolean;
}

/**
 * Translate an application result into MCP text content.
 * Error tags and safe messages remain visible while underlying causes, process
 * output, and other potentially sensitive details stay private.
 */
export const toCallToolResult = (
  result: Result<JsonValue, AnalysisError>,
  contract: ToolContract,
  options: ToolResultOptions = {},
): CallToolResult =>
  result.ok
    ? successResult(result.value, contract, options)
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
  options: ToolResultOptions,
): CallToolResult => {
  const candidate =
    compactEvidence(value) ??
    (contract.kind === "session" ? { result: value } : value);
  const parsed = contract.outputSchema.safeParse(candidate);
  if (!parsed.success) {
    const structuredContent = {
      error: projectAnalysisError(
        new AnalysisOutputError(
          contract.name,
          "output does not match the tool contract",
        ),
      ),
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
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(parsed.data) },
      ...evidenceResourceLinks(
        value,
        contract.kind === "session" ||
          options.evidenceResourcesAvailable === true,
      ),
    ],
    structuredContent: candidate,
  };
};

const compactEvidence = (value: JsonValue): JsonValue | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.evidence_id !== "string" ||
    !/^ev_[a-f0-9]{64}$/u.test(value.evidence_id) ||
    !("normalized_result" in value)
  )
    return undefined;
  return {
    result: value.normalized_result,
    evidence_id: value.evidence_id,
    evidence_uri: `rea://evidence/${value.evidence_id}`,
  };
};

const evidenceResourceLinks = (
  value: JsonValue,
  available: boolean,
): CallToolResult["content"] => {
  if (
    !available ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.evidence_id !== "string" ||
    !/^ev_[a-f0-9]{64}$/u.test(value.evidence_id)
  )
    return [];
  return [
    {
      type: "resource_link",
      uri: `rea://evidence/${value.evidence_id}`,
      name: value.evidence_id,
      description: "Session-owned Evidence v2 record",
      mimeType: "application/json",
    },
  ];
};
