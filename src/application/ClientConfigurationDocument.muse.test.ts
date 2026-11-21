import { describe, expect, it } from "vitest";

import {
  ClientConfigurationShapeError,
  parseClientConfiguration,
} from "./ClientConfigurationDocument.js";

/**
 * Muse Code disables MCP for a session when `settings.json` holds both the
 * canonical `mcpServers` table and the legacy `mcp_servers` table, so a
 * registration into either one would be silently ignored.
 */
describe("Muse Code settings", () => {
  it("reads servers from the canonical table", () => {
    const parsed = parseClientConfiguration(
      '{"schema_version":1,"mcpServers":{"rea":{"type":"stdio","command":"rea"}}}',
      "muse",
    );
    expect(Object.keys(parsed.servers)).toEqual(["rea"]);
  });

  it("refuses a document that holds both spellings", () => {
    let error: unknown;
    try {
      parseClientConfiguration(
        '{"schema_version":1,"mcpServers":{},"mcp_servers":{}}',
        "muse",
      );
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ClientConfigurationShapeError);
    expect(String((error as Error).message)).toContain("mcp_servers");
  });

  it("keeps a document on its legacy table instead of adding the canonical one", () => {
    const parsed = parseClientConfiguration(
      '{"schema_version":1,"mcp_servers":{"rea":{"type":"stdio","command":"rea"}}}',
      "muse",
    );
    expect(Object.keys(parsed.servers)).toEqual(["rea"]);
    expect(parsed.serversPath[0]).toBe("mcp_servers");
  });

  it("keeps unrelated settings when the table is present", () => {
    const parsed = parseClientConfiguration(
      '{"schema_version":2,"theme":"dark","mcpServers":{}}',
      "muse",
    );
    expect(parsed.document.theme).toBe("dark");
    expect(parsed.document.schema_version).toBe(2);
  });
});
