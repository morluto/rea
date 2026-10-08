import { describe, expect, it } from "vitest";

import {
  clientConfigurationServersKey,
  parseClientConfiguration,
} from "./ClientConfigurationDocument.js";

describe("JSON client configuration BOM handling", () => {
  const format = "json" as const;
  const serversKey = clientConfigurationServersKey(format);

  it("reports malformed BOM-prefixed JSON at the original offset", () => {
    const text = `\uFEFF{\r\n  "${serversKey}": {"rea": @}\r\n}`;

    expect(() => parseClientConfiguration(text, format)).toThrow(
      new SyntaxError(
        `Invalid JSON/JSONC at offset ${text.indexOf("@")}: InvalidSymbol`,
      ),
    );
  });

  it.each([
    ["\uFEFF\uFEFF{}", 1],
    [" \uFEFF{}", 1],
    ['{"setting":\uFEFFtrue}', 11],
    ['\uFEFF{"setting":\uFEFFtrue}', 12],
  ] as const)("rejects a nonleading BOM in %j", (text, offset) => {
    expect(() => parseClientConfiguration(text, format)).toThrow(
      new SyntaxError(`Invalid JSON/JSONC at offset ${offset}: InvalidSymbol`),
    );
  });
});

describe("TOML client configuration BOM handling", () => {
  it.each(["", "\uFEFF"])("parses a document with prefix %j", (bom) => {
    const text = '[mcp_servers.rea]\ncommand = "rea"\n';

    expect(parseClientConfiguration(`${bom}${text}`, "toml").servers).toEqual({
      rea: { command: "rea" },
    });
  });
});
