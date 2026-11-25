import { expectResultValue } from "../../tests/support/expectResultValue.js";
import { describe, expect, it } from "vitest";

import {
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
    const result = parseClientConfiguration(text, "json");
    expect(result).toMatchObject({ ok: false, error: { kind: "shape" } });
    if (result.ok) throw new Error("Expected shape error");
    expect(result.error.detail).toContain(location);
    expect(result.error.detail).toContain("object");
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
    const accepts = (text: string): boolean =>
      parseClientConfiguration(text, format).ok;
    if (name === "TOML") expect(accepts("keep = 1\n")).toBe(true);
    if (name === "YAML") expect(accepts("keep: 1\n")).toBe(true);
    if (name === "JSON" || name === "JSONC") {
      expect(accepts('{"keep":1}')).toBe(true);
      expect(accepts('{"keep":1,}')).toBe(name === "JSONC");
      expect(accepts('{"keep":1 /* comment */}')).toBe(name === "JSONC");
    }
  });

  it("reports the syntax failure for unparsable JSON", () => {
    expect(parseClientConfiguration("not-json", "json")).toMatchObject({
      ok: false,
      error: { kind: "syntax", cause: expect.any(SyntaxError) },
    });
  });

  it("reports only duplicates in the effective server object", () => {
    const owned = '{"command":"rea","args":["mcp"]}';
    const activeTable = `{"mcpServers":{"rea":null,"rea":${owned}}}`;
    const active = expectResultValue(
      parseClientConfiguration(activeTable, "json"),
    );
    expect(shadowedClientServers(activeTable, active, "rea")).toEqual({
      servers: [null],
      legacyServers: [],
    });

    // Removing from the effective parent leaves an earlier repeated parent
    // inactive. Its members are not registrations the client would reveal.
    const inactiveParent =
      `{"mcpServers":{"rea":{"command":"/usr/bin/false"}},` +
      `"mcpServers":{"rea":${owned}}}`;
    const parsed = expectResultValue(
      parseClientConfiguration(inactiveParent, "json"),
    );
    expect(shadowedClientServers(inactiveParent, parsed, "rea")).toEqual({
      servers: [],
      legacyServers: [],
    });
  });
});
