import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { expect, it } from "vitest";

import {
  clientServerPath,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
  type ClientConfigurationFormat,
} from "./ClientConfigurationDocument.js";

const replaceLauncher = (source: string, format: ClientConfigurationFormat) => {
  const parsed = parseClientConfiguration(source, format);
  const existing = parsed.servers.rea;
  if (typeof existing !== "object" || existing === null)
    throw new Error("fixture registration missing");
  const document = withClientServers(
    parsed,
    {
      ...parsed.servers,
      rea: { ...existing, command: "new-rea" },
    },
    HOST_PLATFORM.platform,
  );
  const result = serializeClientConfiguration(document, format, source, [
    clientServerPath(parsed, "rea"),
  ]);
  if (!result.ok) throw new Error("launcher replacement refused");
  return result.value;
};

it("retains every unedited token inside and outside a strict JSON launcher row", () => {
  const source = `{"metadata":{"opaque":9007199254740993},"mcpServers":{"peer":{"opaque":9007199254740993},"rea":{"command":"old-rea","metadata":{"opaque":9007199254740993,"nested":[{"number":1e+03,"negative":-0,"text":"\\u0061"}]}}}}`;
  expect(replaceLauncher(source, "fx")).toBe(
    source.replace('"old-rea"', '"new-rea"'),
  );
});

const sourceWithJsoncSyntax = `\uFEFF{/*root*/"metadata":{"opaque":9007199254740993,},"mcpServers":{"rea":{"command":"old-rea",// row\n"opaque":9007199254740993,"text":"/*literal*/",},},}`;

it("repairs JSONC for a strict client while retaining the opaque source tokens", () => {
  const output = replaceLauncher(sourceWithJsoncSyntax, "fx");
  expect(JSON.parse(output)).toEqual({
    metadata: { opaque: 9007199254740992 },
    mcpServers: {
      rea: {
        command: "new-rea",
        opaque: 9007199254740992,
        text: "/*literal*/",
      },
    },
  });
  expect(output.match(/9007199254740993/gu)).toHaveLength(2);
  expect(output).toContain('"/*literal*/"');
});

it("keeps the exact JSONC source outside the changed launcher value", () => {
  expect(replaceLauncher(sourceWithJsoncSyntax, "json")).toBe(
    sourceWithJsoncSyntax.replace('"old-rea"', '"new-rea"'),
  );
});

it("retains nested array tokens while changing siblings, shrinking and extending arrays", () => {
  const source = `{"mcpServers":{"rea":{"command":"rea","items":[{"opaque":9007199254740993,"label":"old"},2,3],"grow":[9007199254740993]}}}`;
  const parsed = parseClientConfiguration(source, "json");
  const result = serializeClientConfiguration(
    withClientServers(
      parsed,
      {
        rea: {
          command: "rea",
          items: [{ opaque: 9007199254740992, label: "new" }],
          grow: [9007199254740992, 4],
        },
      },
      HOST_PLATFORM.platform,
    ),
    "json",
    source,
    [clientServerPath(parsed, "rea")],
  );
  if (!result.ok) throw new Error("nested edit refused");
  expect(result.value.match(/9007199254740993/gu)).toHaveLength(2);
  expect(JSON.parse(result.value).mcpServers.rea).toMatchObject({
    items: [{ label: "new" }],
    grow: [9007199254740992, 4],
  });
});

it("retains source tokens when the caller supplies a whole edited document", () => {
  const source = `{"opaque":9007199254740993,"mcpServers":{"rea":{"command":"old"}}}`;
  const parsed = parseClientConfiguration(source, "fx");
  const result = serializeClientConfiguration(
    withClientServers(
      parsed,
      { rea: { command: "new" } },
      HOST_PLATFORM.platform,
    ),
    "fx",
    source,
  );
  if (!result.ok) throw new Error("whole document edit refused");
  expect(result.value).toContain("9007199254740993");
  expect(JSON.parse(result.value).mcpServers.rea.command).toBe("new");
});

it("removes all repeated nested fields without activating an earlier value", () => {
  const source = `{"mcpServers":{"rea":{"remove":1,"remove":2,"retain":9007199254740993,"command":"old"}}}`;
  const parsed = parseClientConfiguration(source, "json");
  const result = serializeClientConfiguration(
    withClientServers(
      parsed,
      {
        rea: {
          retain: 9007199254740992,
          command: "new",
          added: { enabled: true },
        },
      },
      HOST_PLATFORM.platform,
    ),
    "json",
    source,
    [clientServerPath(parsed, "rea")],
  );
  if (!result.ok) throw new Error("owned row edit refused");
  expect(result.value).not.toContain('"remove"');
  expect(result.value).toContain("9007199254740993");
  expect(JSON.parse(result.value).mcpServers.rea).toMatchObject({
    command: "new",
    added: { enabled: true },
  });
});

it("keeps native JSON separators valid across replaced and emptied collections", () => {
  const source = `{"mcpServers":{"rea":{"replace":{"old":1,},"empty":{"old":2,},"shrink":[1,2,],"clear":[3,4,],}}}`;
  const parsed = parseClientConfiguration(source, "fx");
  const rea = {
    replace: { replacement: true },
    empty: {},
    shrink: [5],
    clear: [],
  };
  const result = serializeClientConfiguration(
    withClientServers(parsed, { rea }, HOST_PLATFORM.platform),
    "fx",
    source,
    [clientServerPath(parsed, "rea")],
  );
  if (!result.ok) throw new Error("collection edit refused");
  expect(JSON.parse(result.value).mcpServers.rea).toEqual(rea);
});
