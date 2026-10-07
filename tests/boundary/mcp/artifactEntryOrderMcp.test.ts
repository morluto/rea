import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { parseConfig } from "../../../src/config.js";
import { createBinarySession } from "../../../src/composition/binary.js";
import { createServer } from "../../../src/server/createServer.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import {
  artifactParentPaths,
  writeOrderedZip,
} from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("returns correct child-first ZIP containment through MCP inspection", async () => {
  const root = await createTestTempDirectory("rea-entry-order-mcp-");
  const archive = join(root, "child-first.zip");
  await writeOrderedZip(archive, ["pkg/sub/data.txt", "pkg/sub/", "pkg/"]);
  const configured = parseConfig({});
  if (!configured.ok) throw configured.error;
  const session = createBinarySession(configured.value);
  const server = createServer(session, session);
  const client = new Client({ name: "entry-order-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path: archive },
        })
      ).isError,
    ).not.toBe(true);
    const called = await client.callTool({
      name: "inspect_artifact",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const inspection = artifactInspectionResultSchema.parse(
      z.object({ result: z.unknown() }).parse(called.structuredContent).result,
    );
    const substep = inspection.substeps[0];
    if (substep === undefined) throw new Error("Missing inventory Evidence");
    const inventory = artifactInventoryResultSchema.parse(
      substep.evidence.normalized_result,
    );
    expect(artifactParentPaths(inventory)).toEqual({
      ".": null,
      pkg: ".",
      "pkg/sub": "pkg",
      "pkg/sub/data.txt": "pkg/sub",
    });
    expect(inspection.coverage.status).toBe("complete-within-substeps");
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
