import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";

const parsed = (text: string) => {
  const result = parseClientConfiguration(text, "mimo");
  if (!result.ok)
    throw new Error(`expected a document, got ${result.error.kind}`);
  return result.value;
};

/**
 * MiMo Code is the opencode family: native servers live under `mcp` with
 * `type: "local"` and an argv array, and its own reader keeps comments.
 */
describe("MiMo Code settings", () => {
  it("reads native servers from the mcp table", () => {
    const document = parsed(
      '{"mcp":{"rea":{"type":"local","command":["rea","mcp"]}}}',
    );
    expect(Object.keys(document.servers)).toEqual(["rea"]);
    expect(document.serversPath[0]).toBe("mcp");
  });

  it("keeps comments and unrelated settings", () => {
    const document = parsed(`{
        // the user keeps this note
        "theme": "dark",
        "mcp": { "rea": { "type": "local", "command": ["rea", "mcp"] } }
      }`);
    expect(document.document.theme).toBe("dark");
    expect(Object.keys(document.servers)).toEqual(["rea"]);
  });

  it("treats a Claude-style mcpServers table as separate from the native one", () => {
    const document = parsed(
      '{"mcpServers":{"from-claude":{"type":"stdio","command":"x"}},"mcp":{}}',
    );
    expect(document.serversPath[0]).toBe("mcp");
    expect(Object.keys(document.servers)).toEqual([]);
  });
});
