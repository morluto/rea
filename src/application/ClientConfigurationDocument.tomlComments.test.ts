import { expect, it } from "vitest";

import {
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
} from "./ClientConfigurationDocument.js";

const original = [
  'root = "retained # root string"',
  "[mcp_servers.rea] # server header note",
  'command = "old # command token" # command note',
  "args = [",
  '  "argument # value token", # array note',
  "]",
  'description = """',
  "# multiline value token",
  '""" # multiline note',
  "literal = 'literal # value token' # literal note",
  "[mcp_servers.rea.tools.binary_session] # tool header note",
  'approval_mode = "approve" # caller approval',
  "[mcp_servers.other]",
  'command = "other" # peer note',
  "",
].join("\n");

for (const format of ["toml", "grok"] as const)
  for (const lineBreak of ["\n", "\r\n"] as const)
    it.each(["replace", "remove"] as const)(
      `retains real comments through %s in ${format} with ${JSON.stringify(lineBreak)}`,
      (operation) => {
        const source = original.replaceAll("\n", lineBreak);
        const parsed = parseClientConfiguration(source, format);
        const { rea: removed, ...peers } = parsed.servers;
        expect(removed).toBeDefined();
        const servers =
          operation === "replace"
            ? { ...peers, rea: { command: "new", args: [] } }
            : peers;
        const result = serializeClientConfiguration(
          withClientServers(parsed, servers),
          format,
          source,
        );
        if (!result.ok) throw new Error("TOML edit was refused");
        for (const comment of [
          "# server header note",
          "# command note",
          "# array note",
          "# multiline note",
          "# literal note",
          "# tool header note",
          "# caller approval",
          "# peer note",
        ])
          expect(result.value.split(comment)).toHaveLength(2);
        for (const stringContent of [
          "# command token",
          "# value token",
          "# multiline value token",
        ])
          expect(result.value).not.toContain(stringContent);
        expect(parseClientConfiguration(result.value, format).document).toEqual(
          {
            root: "retained # root string",
            mcp_servers: servers,
          },
        );
        if (lineBreak === "\r\n")
          expect(result.value.replaceAll("\r\n", "")).not.toContain("\n");
      },
    );

it("retains comments from dotted REA assignments and nested inline values", () => {
  for (const source of [
    'mcp_servers.rea.command = "old # string token" # dotted note\n',
    'mcp_servers = { rea = { args = ["old # string token", # inline value note\n] }, other = { command = "other" } }\n',
  ]) {
    const parsed = parseClientConfiguration(source, "toml");
    const { rea: removed, ...servers } = parsed.servers;
    expect(removed).toBeDefined();
    const result = serializeClientConfiguration(
      withClientServers(parsed, servers),
      "toml",
      source,
    );
    if (!result.ok) throw new Error("TOML removal was refused");
    expect(result.value).toContain(
      source.includes("# dotted note")
        ? "# dotted note"
        : "# inline value note",
    );
    expect(result.value).not.toContain("# string token");
    if (source.includes("# inline value note"))
      expect(result.value.split("\n")[0]).not.toContain("# inline value note");
    expect(parseClientConfiguration(result.value, "toml").servers).toEqual(
      servers,
    );
  }
});

it.each(["toml", "grok"] as const)(
  "retains scalar types in an inline %s registration while refreshing its launcher",
  (format) => {
    const source =
      'mcp_servers = { rea = { command = "old", large = 1e20, exact = 9007199254740992.0, limit = inf, floor = -inf, unknown = nan, zero = -0.0, date = 2026-11-10, clock = 12:34:56, local = 2026-11-10T12:34:56, offset = 2026-11-10T12:34:56-05:00 }, peer = { command = "peer" } } # retained\n';
    const parsed = parseClientConfiguration(source, format);
    const previous = parsed.servers.rea as Record<string, unknown>;
    const servers = {
      ...parsed.servers,
      rea: { ...previous, command: "new" },
    };
    const result = serializeClientConfiguration(
      withClientServers(parsed, servers),
      format,
      source,
    );
    if (!result.ok) throw new Error("TOML edit was refused");
    expect(parseClientConfiguration(result.value, format).servers).toEqual(
      servers,
    );
    expect(result.value).toContain("# retained");
  },
);
