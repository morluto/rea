import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it as test, onTestFinished } from "vitest";

import { HARMONY_ABC_TOOL_CONTRACTS } from "../../../src/contracts/harmony/harmonyAbcToolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { tempRoot, xpandaFixture } from "../providers/harmony/xpandaFixture.js";

const it = test.skipIf(process.platform === "win32");

/** Valid arguments for every named operation, bound to one fake target. */
const argumentsFor = (
  name: (typeof HARMONY_ABC_TOOL_CONTRACTS)[number]["name"],
  target: string,
  output: string,
): Record<string, unknown> => {
  switch (name) {
    case "inspect_harmony_abc":
      return { path: target };
    case "list_harmony_abc_classes":
      return { path: target, offset: 0, limit: 50 };
    case "decompile_harmony_abc_class":
      return { path: target, class_name: "_GLOBAL", simplify: true };
    case "decompile_harmony_abc":
      return { path: target, output_directory: output, simplify: true };
    case "disassemble_harmony_abc_method":
      return {
        path: target,
        class_name: "_GLOBAL",
        max_instructions: 1500,
      };
    case "search_harmony_abc_strings":
      return {
        path: target,
        pattern: "md5",
        regex: false,
        offset: 0,
        limit: 100,
      };
  }
};

it("executes named HarmonyOS contracts with inline Evidence and no native binary admission", async () => {
  const fixture = await xpandaFixture();
  const session = createTestBinarySession(() => {
    throw new Error(
      "HarmonyOS Ark analysis must not acquire a native provider",
    );
  });
  const server = createServer(
    { kind: "session", session },
    { harmonyAbc: fixture.provider },
  );
  const client = new Client(
    { name: "harmony-abc-regression", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = await client.listTools();
  const output = join(await tempRoot(), "decompiled");
  for (const contract of HARMONY_ABC_TOOL_CONTRACTS) {
    expect(
      advertised.tools.find((tool) => tool.name === contract.name)?.annotations,
    ).toMatchObject(contract.annotations);
    const response = await client.callTool({
      name: contract.name,
      arguments: argumentsFor(contract.name, fixture.targetPath, output),
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const result = contract.outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(result);
    expect(evidence.operation).toBe(contract.name);
    expect(evidence.provider.id).toBe("xpanda");
    expect(evidence.subject?.identity).toMatchObject({
      kind: "file",
      format: "abc",
    });
    expect(evidence.raw_result).not.toBeNull();
  }
});

it("reports unavailable HarmonyOS capability without a configured checkout", async () => {
  const session = createTestBinarySession(() => {
    throw new Error(
      "HarmonyOS Ark analysis must not acquire a native provider",
    );
  });
  const server = createServer(
    { kind: "session", session },
    // No harmonyAbcAnalysis and no REA_XPANDA_ROOT in this test process.
    { environment: {} },
  );
  const client = new Client(
    { name: "harmony-abc-unconfigured", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(status.isError).not.toBe(true);
  const inventory = JSON.stringify(status.structuredContent);
  expect(inventory).toContain("inspect_harmony_abc");
  expect(inventory).toContain("REA_XPANDA_ROOT");
});
