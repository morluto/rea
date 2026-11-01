import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { denoElf } from "../../../src/artifacts/deno/DenoStandalone.fixture.js";
import { artifactInventorySummaryViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("exposes Deno compile metadata through the existing MCP artifact tool", async () => {
  const root = await createTestTempDirectory("rea-deno-mcp-");
  const path = join(root, "app");
  await writeFile(path, denoElf());
  const session = createTestBinarySession(new ArtifactProvider({}));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "deno-contract-test", version: "1" });
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
      kind: "deno-standalone",
      carrier: "elf",
      embedding: "elf-note",
      entrypoint_key: "main.ts",
    });
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
