import { describe, expect, it } from "vitest";

import {
  ClientConfigurationShapeError,
  clientConfigurationSyntaxName,
  parseClientConfiguration,
  shadowedClientServers,
} from "./ClientConfigurationDocument.js";

describe("parseClientConfiguration shape diagnostics", () => {
  it.each([
    ["null root", "null", "root"],
    ["array root", "[]", "root"],
    ["string root", '"x"', "root"],
    ["null server table", '{"mcpServers":null,"keep":1}', "mcpServers"],
    ["array server table", '{"mcpServers":[],"keep":1}', "mcpServers"],
    ["string server table", '{"mcpServers":"x","keep":1}', "mcpServers"],
  ])("reports a non-object %s", (_label, text, location) => {
    let error: unknown;
    try {
      parseClientConfiguration(text, "json");
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ClientConfigurationShapeError);
    if (!(error instanceof Error)) throw new Error("Expected shape error");
    expect(error.message).toContain(location);
    expect(error.message).toContain("object");
  });

  // The diagnostic syntax name must describe what the reader actually admits.
  it.each([
    ["json", "JSONC"],
    ["vscode", "JSONC"],
    ["opencode", "JSONC"],
    ["kilo", "JSONC"],
    ["zed", "JSONC"],
    ["amp", "JSONC"],
    ["copilot_cli", "JSONC"],
    ["fx", "JSONC"],
    ["claude_code", "JSON"],
    ["pi", "JSON"],
    ["kimi", "JSON"],
    ["lm_studio", "JSON"],
    ["zcode", "JSON"],
    ["toml", "TOML"],
    ["grok", "TOML"],
    ["goose", "YAML"],
    ["hermes", "YAML"],
  ] as const)("names %s configuration syntax %s", (format, name) => {
    expect(clientConfigurationSyntaxName(format)).toBe(name);
    const accepts = (text: string): boolean => {
      try {
        parseClientConfiguration(text, format);
        return true;
      } catch {
        return false;
      }
    };
    if (name === "TOML") expect(accepts("keep = 1\n")).toBe(true);
    if (name === "YAML") expect(accepts("keep: 1\n")).toBe(true);
    if (name === "JSON" || name === "JSONC") {
      expect(accepts('{"keep":1}')).toBe(true);
      expect(accepts('{"keep":1,}')).toBe(name === "JSONC");
      expect(accepts('{"keep":1 /* comment */}')).toBe(name === "JSONC");
    }
  });

  it("still rejects unparsable JSON with SyntaxError", () => {
    expect(() => parseClientConfiguration("not-json", "json")).toThrow(
      SyntaxError,
    );
  });

  it("reports only duplicates in the effective server object", () => {
    const owned = '{"command":"rea","args":["mcp"]}';
    const activeTable = `{"mcpServers":{"rea":null,"rea":${owned}}}`;
    const active = parseClientConfiguration(activeTable, "json");
    expect(shadowedClientServers(activeTable, active, "rea")).toEqual({
      servers: [null],
      legacyServers: [],
    });

    // Removing from the effective parent leaves an earlier repeated parent
    // inactive. Its members are not registrations the client would reveal.
    const inactiveParent =
      `{"mcpServers":{"rea":{"command":"/usr/bin/false"}},` +
      `"mcpServers":{"rea":${owned}}}`;
    const parsed = parseClientConfiguration(inactiveParent, "json");
    expect(shadowedClientServers(inactiveParent, parsed, "rea")).toEqual({
      servers: [],
      legacyServers: [],
    });
  });
});
