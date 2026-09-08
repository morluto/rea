import type { JsonValue } from "../domain/jsonValue.js";

/** Encode one JSON value as an MCP resource with its requested URI. */
export const jsonResource = (uri: string, value: JsonValue) => ({
  contents: [
    {
      uri,
      mimeType: "application/json" as const,
      text: JSON.stringify(value, null, 2),
    },
  ],
});
