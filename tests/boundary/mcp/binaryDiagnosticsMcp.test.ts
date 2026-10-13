import {
  advertisedMcpToolSchemas,
  assertRecordedMcpEvidence,
} from "../../fixtures/advertisedMcpTool.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  binaryLayoutFixture,
  BINARY_LAYOUT_TEST_PROVIDER,
} from "../../fixtures/binaryDiagnostics/layout.js";

it("advertises exact valid schemas and records inline layout without a binary target", async () => {
  const value = binaryLayoutFixture();
  let providerClosed = false;
  const service = new BinaryLayoutService({
    inspectAndClose(input, options) {
      return this.inspect(input, options);
    },
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(value)),
    close: async () => {
      providerClosed = true;
    },
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { binaryLayout: service },
  );
  const client = new Client({ name: "binary-layout-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    expect(providerClosed).toBe(true);
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_binary_layout",
  );
  const { ajv, inputSchema } = schemas;
  expect(ajv.validate(inputSchema, { path: value.artifact.path })).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,
      approval: true,
    }),
  ).toBe(false);
  const response = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { path: value.artifact.path },
  });
  const evidence = assertRecordedMcpEvidence(
    response,
    "inspect_binary_layout",
    schemas,
    session,
    value,
    "observed",
  );
  const viewed = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: evidence.evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(viewed.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      viewed.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    kind: "summary",
    parent_evidence_id: evidence.evidence_id,
    summary: { format: "elf", bytes: value.artifact.bytes },
  });
  expect(
    (
      await client.callTool({
        name: "inspect_binary_layout",
        arguments: { path: "relative.elf" },
      })
    ).isError,
  ).toBe(true);
});
