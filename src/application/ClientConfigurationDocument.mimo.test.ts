import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";

/**
 * MiMo Code is the opencode family: native servers live under `mcp` with
 * `type: "local"` and an argv array, and its own reader keeps comments.
 */
describe("MiMo Code settings", () => {
  it("reads native servers from the mcp table", () => {
    const parsed = parseClientConfiguration(
      '{"mcp":{"rea":{"type":"local","command":["rea","mcp"]}}}',
      "mimo",
    );
    expect(Object.keys(parsed.servers)).toEqual(["rea"]);
    expect(parsed.serversPath[0]).toBe("mcp");
  });

  it("keeps comments and unrelated settings", () => {
    const parsed = parseClientConfiguration(
      `{
        // the user keeps this note
        "theme": "dark",
        "mcp": { "rea": { "type": "local", "command": ["rea", "mcp"] } }
      }`,
      "mimo",
    );
    expect(parsed.document.theme).toBe("dark");
    expect(Object.keys(parsed.servers)).toEqual(["rea"]);
  });

  it("treats a Claude-style mcpServers table as separate from the native one", () => {
    const parsed = parseClientConfiguration(
      '{"mcpServers":{"from-claude":{"type":"stdio","command":"x"}},"mcp":{}}',
      "mimo",
    );
    expect(parsed.serversPath[0]).toBe("mcp");
    expect(Object.keys(parsed.servers)).toEqual([]);
  });
});
