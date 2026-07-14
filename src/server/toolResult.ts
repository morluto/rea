import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  AnalysisOutputError,
  projectAnalysisError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ToolContract } from "../contracts/toolContracts.js";

/**
 * Translate an application result into MCP text content.
 * Error tags and safe messages remain visible while underlying causes, process
 * output, and other potentially sensitive details stay private.
 */
export const toCallToolResult = (
  result: Result<JsonValue, AnalysisError>,
  contract: ToolContract,
): CallToolResult =>
  result.ok ? successResult(result.value, contract) : errorResult(result.error);

const errorResult = (error: AnalysisError): CallToolResult => {
  const projected = projectAnalysisError(error);
  return {
    content: [
      {
        type: "text",
        text: projected.message,
      },
    ],
    structuredContent: { error: projected },
    isError: true,
  };
};

const successResult = (
  value: JsonValue,
  contract: ToolContract,
): CallToolResult => {
  const candidate = contract.kind === "session" ? { result: value } : value;
  const parsed = contract.outputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      content: [
        {
          type: "text",
          text: "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
        },
      ],
      structuredContent: {
        error: projectAnalysisError(
          new AnalysisOutputError(
            contract.name,
            "output does not match the tool contract",
          ),
        ),
      },
      isError: true,
    };
  }
  return {
    content: [
      { type: "text", text: formatValue(value) },
      ...evidenceResourceLinks(value),
    ],
    structuredContent: candidate,
  };
};

const evidenceResourceLinks = (value: JsonValue): CallToolResult["content"] => {
  if (
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

const formatValue = (value: JsonValue): string => {
  if (value === null) return "OK";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};
