import { constants as bufferConstants } from "node:buffer";

import type { JsonValue } from "../domain/jsonValue.js";
import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

export const MCP_RESULT_STRING_LIMIT = bufferConstants.MAX_STRING_LENGTH - 1024;

const RESULT_ENVELOPE_BYTES =
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: "" }],
      structuredContent: null,
    }),
  ) - 4;

/** Result of encoding the complete repeated MCP representations within a wire budget. */
export type ToolResultEncoding =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | {
      readonly ok: false;
      readonly bytesAtLeast: number;
      readonly codeUnitsAtLeast: number;
      readonly constraint: "receive-buffer" | "string-length";
    };

/** Account for structured JSON and escaped text before allocating the complete text. */
export const encodeToolResult = (
  value: JsonValue,
  budgetBytes: number,
): ToolResultEncoding => {
  const parts: string[] = [];
  let bytes = RESULT_ENVELOPE_BYTES;
  let codeUnits = RESULT_ENVELOPE_BYTES;
  for (const part of bufferedJsonParts(jsonParts(value))) {
    const escapedPart = JSON.stringify(part);
    bytes += Buffer.byteLength(part) + Buffer.byteLength(escapedPart) - 2;
    codeUnits += part.length + escapedPart.length - 2;
    if (bytes > budgetBytes || codeUnits > MCP_RESULT_STRING_LIMIT)
      return {
        ok: false,
        bytesAtLeast: bytes,
        codeUnitsAtLeast: codeUnits,
        constraint:
          codeUnits > MCP_RESULT_STRING_LIMIT
            ? "string-length"
            : "receive-buffer",
      };
    parts.push(part);
  }
  return { ok: true, text: parts.join(""), bytes };
};
