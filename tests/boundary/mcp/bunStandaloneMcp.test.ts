import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInventorySummaryViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import {
  bunModuleGraphPayload,
  elfAppendedBunPayload,
} from "../../../src/artifacts/bun/BunStandalone.fixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

it("exposes Bun graph metadata through the existing MCP artifact tool", async () => {
  const root = await createTestTempDirectory("rea-bun-mcp-");
  const path = join(root, "app");
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "/$bunfs/root/main.js", contents: Buffer.from("hello") },
        ],
      }),
    ),
  );
  const session = createTestBinarySession(new ArtifactProvider({}));
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "bun-contract-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      (await client.callTool({ name: "open_binary", arguments: { path } }))
        .isError,
    ).not.toBe(true);
    const reply = await client.callTool({
      name: "inspect_artifact",
      arguments: { detail: "summary" },
    });
    expect(reply.isError).not.toBe(true);
    const summary = artifactInventorySummaryViewResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    expect(summary.summary.root_format_metadata).toMatchObject({
      kind: "bun-standalone",
      module_count: 1,
      entry_point_source_name: "/$bunfs/root/main.js",
    });
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("keeps a budget-limited Bun layout unresolved through MCP", async () => {
  const root = await createTestTempDirectory("rea-bun-layout-mcp-");
  const path = join(root, "app");
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ loader: 0, moduleFormat: 0 }],
        tableLength: 468,
      }),
    ),
  );
  const { client } = await createApplicationMcpHarness({
    session: createTestBinarySession(new ArtifactProvider({})),
    clientIdentity: { name: "bun-layout-budget", version: "1" },
  });
  expect(
    (await client.callTool({ name: "open_binary", arguments: { path } }))
      .isError,
  ).not.toBe(true);
  for (const moduleCount of [9, 13]) {
    const reply = await client.callTool({
      name: "inspect_artifact",
      arguments: { artifact_limits: { bun: { module_count: moduleCount } } },
    });
    expect(reply.isError).toBe(true);
    expect(parseMcpToolError(reply).error).toMatchObject({
      code: moduleCount < 13 ? "truncated" : "artifact_operation_failed",
      retryable: moduleCount < 13,
      details:
        moduleCount < 13
          ? {
              reason: "limit",
              reader_limit: {
                parameter: "artifact_limits.bun.module_count",
                required_value: 13,
              },
            }
          : { reason: "unavailable" },
    });
  }
});
