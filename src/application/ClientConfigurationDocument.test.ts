import { describe, expect, it } from "vitest";

import {
  clientConfigurationServersKey,
  clientRegistrationEntry,
  parseClientConfiguration,
  serializeClientConfiguration,
} from "./ClientConfigurationDocument.js";

describe.each([
  "json",
  "vscode",
  "copilot_cli",
  "opencode",
  "commandcode",
] as const)("%s client configuration BOM handling", (format) => {
  const serversKey = clientConfigurationServersKey(format);

  it.each(["", "\uFEFF"])("parses a document with prefix %j", (bom) => {
    const registration = clientRegistrationEntry(format, ["rea", "mcp"], {});
    const document = { [serversKey]: { rea: registration } };

    expect(
      parseClientConfiguration(`${bom}${JSON.stringify(document)}`, format),
    ).toEqual({
      document,
      servers: document[serversKey],
      serversPath: [serversKey],
      dialect: format,
      legacyServers: {},
    });
  });

  it.each(["", "\uFEFF"])(
    "reports malformed JSON at the original offset with prefix %j",
    (bom) => {
      const text = `${bom}{\r\n  "${serversKey}": {"rea": @}\r\n}`;

      expect(() => parseClientConfiguration(text, format)).toThrow(
        new SyntaxError(
          `Invalid JSON/JSONC at offset ${text.indexOf("@")}: InvalidSymbol`,
        ),
      );
    },
  );

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

  it.each(["", "\uFEFF"])(
    "preserves prefix %j and unrelated bytes across add, update, and removal",
    (bom) => {
      const prefix = `${bom}{\r\n  // Keep \uFEFF in comments.\r\n  "label": "left\uFEFFright",\r\n  "${serversKey}": {\r\n    // Other server.\r\n    "other": {\r\n      "command": "other\uFEFFtool"\r\n    },\r\n`;
      const suffix = '  },\r\n  "theme": "dark",\r\n}\r\n';
      const original = `${prefix}${suffix}`;
      let text = original;

      for (const registration of [
        clientRegistrationEntry(format, ["rea", "mcp"], {}),
        clientRegistrationEntry(format, ["rea-next", "mcp"], {
          LABEL: "left\uFEFFright",
        }),
        undefined,
      ]) {
        const parsed = parseClientConfiguration(text, format);
        const servers = { ...parsed.servers };
        if (registration === undefined) delete servers.rea;
        else servers.rea = registration;
        const document = { ...parsed.document, [serversKey]: servers };

        text = serializeClientConfiguration(document, format, text, [
          [serversKey, "rea"],
        ]);

        expect(parseClientConfiguration(text, format)).toEqual({
          document,
          servers,
          serversPath: [serversKey],
          dialect: format,
          legacyServers: {},
        });
        expect(Buffer.from(text.slice(0, prefix.length))).toEqual(
          Buffer.from(prefix),
        );
        expect(Buffer.from(text.slice(-suffix.length))).toEqual(
          Buffer.from(suffix),
        );
        expect(text.replaceAll("\r\n", "")).not.toContain("\n");
      }

      expect(text).toBe(original);
    },
  );
});

describe("TOML client configuration BOM handling", () => {
  it.each(["", "\uFEFF"])("parses a document with prefix %j", (bom) => {
    const text = '[mcp_servers.rea]\ncommand = "rea"\n';

    expect(parseClientConfiguration(`${bom}${text}`, "toml").servers).toEqual({
      rea: { command: "rea" },
    });
  });
});
