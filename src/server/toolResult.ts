import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolContract } from "../contracts/toolContracts.js";
import { projectAnalysisError, type AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

interface ToolResultOptions {
  readonly evidenceResourcesAvailable?: boolean;
  readonly evidenceResultProjection?: JsonValue;
  readonly evidenceTextProjection?: JsonValue;
  readonly resourceLinks?: readonly {
    readonly uri: string;
    readonly name: string;
    readonly description: string;
  }[];
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
    compactEvidence(value, options.evidenceResultProjection) ??
    (contract.kind === "session" ? { result: value } : value);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          options.evidenceTextProjection === undefined
            ? candidate
            : (compactEvidence(value, options.evidenceTextProjection) ??
                options.evidenceTextProjection),
        ),
      },
      ...(hasResourceLinks(value, contract, options)
        ? [
            {
              type: "text" as const,
              text: "Full detail is available through MCP resources/read. Copy the opaque URI exactly. In Codex, call read_mcp_resource.",
            },
          ]
        : []),
      ...evidenceResourceLinks(
        value,
        contract.kind === "session" ||
          options.evidenceResourcesAvailable === true,
      ),
      ...(options.resourceLinks ?? []).map((resource) => ({
        type: "resource_link" as const,
        ...resource,
        mimeType: "application/json" as const,
      })),
    ],
    structuredContent: candidate,
  };
};

const hasResourceLinks = (
  value: JsonValue,
  contract: ToolContract,
  options: ToolResultOptions,
): boolean =>
  options.resourceLinks !== undefined && options.resourceLinks.length > 0
    ? true
    : evidenceResourceLinks(
        value,
        contract.kind === "session" ||
          options.evidenceResourcesAvailable === true,
      ).length > 0;

const compactEvidence = (
  value: JsonValue,
  resultProjection: JsonValue | undefined,
): JsonValue | undefined => {
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
    result: resultProjection ?? value.normalized_result,
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
