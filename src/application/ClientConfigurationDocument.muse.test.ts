import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";

const parsed = (text: string) => {
  const result = parseClientConfiguration(text, "muse");
  if (!result.ok)
    throw new Error(`expected a document, got ${result.error.kind}`);
  return result.value;
};

/**
 * Muse Code disables MCP for a session when `settings.json` holds both the
 * canonical `mcpServers` table and the legacy `mcp_servers` table, so a
 * registration into either one would be silently ignored.
 */
describe("Muse Code settings", () => {
  it("reads servers from the canonical table", () => {
    const document = parsed(
      '{"schema_version":1,"mcpServers":{"rea":{"type":"stdio","command":"rea"}}}',
    );
    expect(Object.keys(document.servers)).toEqual(["rea"]);
  });

  it("refuses a document that holds both spellings", () => {
    const result = parseClientConfiguration(
      '{"schema_version":1,"mcpServers":{},"mcp_servers":{}}',
      "muse",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("shape");
    expect(result.error.detail).toContain("mcp_servers");
  });

  it("keeps a document on its legacy table instead of adding the canonical one", () => {
    const document = parsed(
      '{"schema_version":1,"mcp_servers":{"rea":{"type":"stdio","command":"rea"}}}',
    );
    expect(Object.keys(document.servers)).toEqual(["rea"]);
    expect(document.serversPath[0]).toBe("mcp_servers");
  });

  it("keeps unrelated settings when the table is present", () => {
    const document = parsed(
      '{"schema_version":2,"theme":"dark","mcpServers":{}}',
    );
    expect(document.document.theme).toBe("dark");
    expect(document.document.schema_version).toBe(2);
  });
});
