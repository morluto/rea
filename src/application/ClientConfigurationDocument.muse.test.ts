import { describe, expect, it } from "vitest";

import {
  clientRegistrationLauncherEntry,
  parseClientConfiguration,
} from "./ClientConfigurationDocument.js";
import { clientConfigurationForWrite } from "./ClientConfigurationFiles.js";

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

/**
 * Muse Code requires `type: "stdio"` on a registration row, so the launcher a
 * fresh row starts from must carry it rather than relying on a prior row.
 */
describe("Muse Code registration launcher entry", () => {
  it("carries the stdio type a fresh row needs", () => {
    expect(clientRegistrationLauncherEntry("muse", ["rea", "mcp"])).toEqual({
      type: "stdio",
      command: "rea",
      args: ["mcp"],
    });
  });
});

/**
 * Muse Code requires a numeric `schema_version`. A document that does not carry
 * one yet is written with it, so setup cannot produce a settings file the
 * client refuses to load.
 */
describe("Muse Code write fragment", () => {
  const written = (text: string) => {
    const parsed = parseClientConfiguration(text, "muse");
    if (!parsed.ok)
      throw new Error(`expected a document, got ${parsed.error.kind}`);
    const forWrite = clientConfigurationForWrite(parsed.value, [parsed.value]);
    if (!forWrite.ok) throw forWrite.error;
    return forWrite.value.document;
  };

  it("writes the schema version a fresh document lacks", () => {
    expect(written('{"mcpServers":{}}')).toMatchObject({ schema_version: 1 });
  });

  it("keeps the version a caller already declared", () => {
    expect(written('{"schema_version":3,"mcpServers":{}}')).toMatchObject({
      schema_version: 3,
    });
  });
});

/**
 * A removal path establishes ownership from either table, so it reads an
 * ambiguous document instead of refusing it; only a write must choose one.
 */
describe("Muse Code dual-table documents", () => {
  const dual =
    '{"schema_version":1,"mcpServers":{"rea":{"type":"stdio","command":"rea"}},"mcp_servers":{}}';

  it("refuses a write that would have to choose a table", () => {
    const refused = parseClientConfiguration(dual, "muse");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe("shape");
  });

  it("reads both tables when a removal asks it to", () => {
    const preserved = parseClientConfiguration(dual, "muse", "preserve");
    expect(preserved.ok).toBe(true);
    if (!preserved.ok) return;
    // The owned row is visible, so uninstall can establish ownership and remove it.
    expect(Object.keys(preserved.value.servers)).toEqual(["rea"]);
    expect(preserved.value.document.mcp_servers).toEqual({});
  });
});
