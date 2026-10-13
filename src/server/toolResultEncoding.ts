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

const TEXT_RESULT_ENVELOPE_BYTES = Buffer.byteLength(
  JSON.stringify({ content: [{ type: "text", text: "" }] }),
);

/**
 * Result metadata marking content that originates from the analysis target.
 * Hosts and hooks can read it to treat the result as untrusted data.
 */
export const TARGET_CONTENT_RESULT_META = Object.freeze({
  provenance: Object.freeze({
    untrusted_content: true,
    source: "analysis_target",
  }),
});

/** Whether a delivered tool result already carries the untrusted target-content marker. */
export const carriesTargetContentMarker = (result: {
  readonly _meta?: unknown;
}): boolean => {
  const meta = result._meta;
  if (typeof meta !== "object" || meta === null) return false;
  const provenance: unknown = Reflect.get(meta, "provenance");
  return (
    typeof provenance === "object" &&
    provenance !== null &&
    Reflect.get(provenance, "untrusted_content") === true
  );
};

// `,"_meta":{...}` added to the delivered result object.
const TARGET_CONTENT_META_BYTES =
  Buffer.byteLength(JSON.stringify({ _meta: TARGET_CONTENT_RESULT_META })) - 1;

/**
 * MCP representations a result carries on the wire. Successful results repeat
 * the JSON as structured content and escaped text; error results carry text only.
 */
export type ToolResultRepresentations = "structured-and-text" | "text";

/** Result of encoding the complete repeated MCP representations within a wire budget. */
export type ToolResultEncoding =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | {
      readonly ok: false;
      readonly bytesAtLeast: number;
      readonly codeUnitsAtLeast: number;
      readonly constraint: "receive-buffer" | "string-length";
    };

/** Account for the delivered JSON representations before allocating the complete text. */
export const encodeToolResult = (
  value: JsonValue,
  budgetBytes: number,
  representations: ToolResultRepresentations = "structured-and-text",
  targetContent = false,
): ToolResultEncoding => {
  const structured = representations === "structured-and-text";
  const parts: string[] = [];
  let bytes =
    (structured ? RESULT_ENVELOPE_BYTES : TEXT_RESULT_ENVELOPE_BYTES) +
    (targetContent ? TARGET_CONTENT_META_BYTES : 0);
  let codeUnits = bytes;
  for (const part of bufferedJsonParts(jsonParts(value))) {
    const escapedPart = JSON.stringify(part);
    bytes +=
      (structured ? Buffer.byteLength(part) : 0) +
      Buffer.byteLength(escapedPart) -
      2;
    codeUnits += (structured ? part.length : 0) + escapedPart.length - 2;
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
