import type { CallToolResult } from "@modelcontextprotocol/server";

import type { AnalysisError } from "../domain/errors.js";
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
  result.ok
    ? successResult(result.value, contract)
    : {
        content: [
          {
            type: "text",
            text: `${result.error._tag}: ${result.error.message}`,
          },
        ],
        isError: true,
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
          text: "HopperProtocolError: Analysis output does not match the tool contract",
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: formatValue(value) }],
    structuredContent: candidate,
  };
};

const formatValue = (value: JsonValue): string => {
  if (value === null) return "OK";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};
