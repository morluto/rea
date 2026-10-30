import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { priResourcesSchema } from "../../../src/domain/native/priResources.js";
import { priFixture } from "../../../src/native/pri/PriResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const contract = toolContract("inspect_pri_resources");

/** One selection expressed as CLI flags and as the equivalent MCP arguments. */
const selections: readonly {
  readonly flags: readonly string[];
  readonly arguments: Record<string, unknown>;
}[] = [
  { flags: [], arguments: {} },
  {
    flags: [
      "--collection",
      "candidates",
      "--query",
      "resources/",
      "--qualifier",
      "Language=en-us",
      "--value-type",
      "String",
      "--value-type",
      "AsciiString",
    ],
    arguments: {
      collection: "candidates",
      query: "resources/",
      qualifiers: [{ name: "Language", value: "en-us" }],
      value_types: ["String", "AsciiString"],
    },
  },
  {
    flags: [
      "--collection",
      "candidates",
      "--name",
      "Files/Views/Main.xbf",
      "--name",
      "Files/Assets/Logo.png",
      "--offset",
      "1",
      "--limit",
      "1",
    ],
    arguments: {
      collection: "candidates",
      names: ["Files/Views/Main.xbf", "Files/Assets/Logo.png"],
      offset: 1,
      limit: 1,
    },
  },
  {
    flags: ["--collection", "sections"],
    arguments: { collection: "sections" },
  },
];

const expectInputFailureAcrossAdapters = async (
  cli: TestCli,
  client: Client,
  path: string,
  reason: "invalid_format" | "invalid_value",
) => {
  const result = await cli.run({
    arguments: ["inspect-pri-resources", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      operation: "inspect_pri_resources",
      issues: [{ path: ["path"], reason }],
    },
  });
  const response = await client.callTool({
    name: contract.name,
    arguments: { path },
  });
  expect(parseMcpToolError(response)).toEqual({ error: result.json });
};

/** Each selection returns the same Evidence through the CLI and MCP. */
const expectSelectionParity = async (
  cli: TestCli,
  client: Client,
  path: string,
  fixture: Buffer,
) => {
  for (const selection of selections) {
    const result = await cli.run({
      arguments: ["inspect-pri-resources", path, ...selection.flags, "--json"],
    });
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.subject).toMatchObject({
      format: "file",
      digest: { sha256: createHash("sha256").update(fixture).digest("hex") },
    });
    expect(
      priResourcesSchema.parse(evidence.normalized_result).coverage,
    ).toMatchObject({ status: "complete", items: 4, candidates: 8 });
    const response = await client.callTool({
      name: contract.name,
      arguments: { path, ...selection.arguments },
    });
    expect(response.isError).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    const text = response.content.find(({ type }) => type === "text");
    if (text?.type !== "text") throw new Error("Missing MCP text Evidence");
    expect(contract.outputSchema.parse(JSON.parse(text.text)).evidence_id).toBe(
      evidence.evidence_id,
    );
  }
  const strings = await client.callTool({
    name: contract.name,
    arguments: { path, ...selections[1]?.arguments },
  });
  expect(
    priResourcesSchema.parse(
      contract.outputSchema.parse(strings.structuredContent).normalized_result,
    ).page,
  ).toMatchObject({
    collection: "candidates",
    total: 2,
    candidates: [
      {
        name: "Resources/AppDisplayName",
        value: { kind: "text", text: "Sample App" },
      },
      {
        name: "Resources/Greeting/Text",
        value: { kind: "text", text: "Hello & <welcome>" },
      },
    ],
  });
};

/** Malformed files and arguments fail the same way through both adapters. */
const expectRejections = async (
  cli: TestCli,
  client: Client,
  root: string,
  path: string,
) => {
  const malformed = join(root, "malformed.pri");
  await writeFile(malformed, Buffer.from("not a resource index"));
  const damaged = priFixture();
  damaged.bytes.writeUInt32LE(damaged.bytes.length + 8, 12);
  const damagedPath = join(root, "damaged.pri");
  await writeFile(damagedPath, damaged.bytes);
  for (const [candidate, reason] of [
    [malformed, "invalid_format"],
    [join(root, "missing.pri"), "invalid_value"],
    [damagedPath, "invalid_format"],
  ] as const)
    await expectInputFailureAcrossAdapters(cli, client, candidate, reason);
  const badQualifier = await cli.run({
    arguments: [
      "inspect-pri-resources",
      path,
      "--qualifier",
      "Language",
      "--json",
    ],
  });
  expect(badQualifier.exitCode).toBe(1);
  expect(badQualifier.json).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["qualifiers", 0, "value"] }] },
  });
  for (const arguments_ of [
    { path: "relative.pri" },
    { path, extra: true },
    { path, limit: 0 },
    { path, collection: "sections", query: "Resources" },
    { path, qualifiers: [{ name: "Unknown", value: "x" }] },
  ]) {
    const rejected = await client.callTool({
      name: contract.name,
      arguments: arguments_,
    });
    expect(rejected.isError).toBe(true);
    expect(
      contract.outputSchema.safeParse(rejected.structuredContent).success,
    ).toBe(false);
  }
};

cliTest(
  "inspects PRI resource indexes through compiled CLI and real stdio MCP without an active target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pri-resource-acceptance-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({
      name: "pri-resource-acceptance",
      version: "1",
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toContainEqual(
        expect.objectContaining({
          name: contract.name,
          annotations: expect.objectContaining({
            readOnlyHint: false,
            openWorldHint: false,
          }),
        }),
      );
      const session = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(JSON.stringify(session.structuredContent)).toContain(
        contract.name,
      );
      for (const [label, options] of [
        ["windows10", {}],
        ["windows81", { magic: "mrm_pri1", schema: "unicode", mapVersion: 1 }],
      ] as const) {
        const fixture = priFixture(options);
        const path = join(root, `${label}.pri`);
        await writeFile(path, fixture.bytes);
        await expectSelectionParity(cli, client, path, fixture.bytes);
        expect((await readFile(path)).equals(fixture.bytes)).toBe(true);
      }
      await expectRejections(cli, client, root, join(root, "windows10.pri"));
      await client.ping();
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
  60_000,
);
