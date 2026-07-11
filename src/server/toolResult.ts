import type { CallToolResult } from "@modelcontextprotocol/server";

import type { HopperError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { JsonValue } from "../hopper/protocol.js";

/** Translate an application result into caller-visible MCP content. */
export const toCallToolResult = (
  result: Result<JsonValue, HopperError>,
): CallToolResult =>
  result.ok
    ? { content: [{ type: "text", text: formatValue(result.value) }] }
    : {
        content: [
          {
            type: "text",
            text: `${result.error._tag}: ${result.error.message}`,
          },
        ],
        isError: true,
      };

const formatValue = (value: JsonValue): string => {
  if (value === null) return "OK";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};
