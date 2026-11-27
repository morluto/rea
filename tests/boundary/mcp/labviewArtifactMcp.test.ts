import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { buildLabviewRsrc } from "../../fixtures/labview/rsrc.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider should start");
  });
  const server = createServer(
    { kind: "session", session },
    { environment: {}, logger: silentLogger },
  );
  const client = new Client(
    { name: "labview-test", version: "1" },
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
  return client;
};

describe("inspect_labview_artifact delivery", () => {
  it("summarizes the inventory and pages blocks and sections from retained Evidence", async () => {
    const dir = await createTestTempDirectory("rea-labview-mcp-");
    const path = join(dir, "fixture.vi");
    await writeFile(
      path,
      buildLabviewRsrc([
        { ident: "LVSR", sections: [Buffer.from("a")] },
        {
          ident: "DFDS",
          sections: [Buffer.from("b"), Buffer.from("cc"), Buffer.from("ddd")],
        },
        { ident: "LIvi", sections: [Buffer.from("e")] },
      ]),
    );
    const client = await connect();

    const summaryRes = await client.callTool({
      name: "inspect_labview_artifact",
      arguments: { path, detail: "summary" },
    });
    expect(summaryRes.isError).not.toBe(true);
    const summary = summaryRes.structuredContent as {
      evidence_links: string[];
      normalized_result: Record<string, unknown>;
    };
    expect(summary.normalized_result).toMatchObject({
      kind: "summary",
      parent_operation: "inspect_labview_artifact",
      summary: { block_count: 3, section_count: 5 },
    });
    expect(summary.normalized_result).not.toHaveProperty("blocks");
    const parentId = summary.evidence_links[0];
    expect(parentId).toMatch(/^ev_[0-9a-f]{64}$/u);

    const blocksRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: {
          kind: "labview-artifact",
          collection: "blocks",
          offset: 1,
          limit: 1,
        },
      },
    });
    expect(blocksRes.isError).not.toBe(true);
    expect(
      (blocksRes.structuredContent as { normalized_result: unknown })
        .normalized_result,
    ).toMatchObject({
      items: [{ identifier: "DFDS", section_count: 3, source_index: 1 }],
      coverage: { total: 3 },
    });

    const sectionsRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: {
          kind: "labview-artifact",
          collection: "sections",
          block: "DFDS",
          offset: 1,
          limit: 10,
        },
      },
    });
    expect(sectionsRes.isError).not.toBe(true);
    expect(
      (sectionsRes.structuredContent as { normalized_result: unknown })
        .normalized_result,
    ).toMatchObject({
      items: [
        { block: "DFDS", block_index: 1, stored_bytes: 2 },
        { block: "DFDS", block_index: 1, stored_bytes: 3 },
      ],
    });

    // An unfiltered page that crosses a block boundary keeps flat source order.
    const crossRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: {
          kind: "labview-artifact",
          collection: "sections",
          offset: 3,
          limit: 5,
        },
      },
    });
    expect(crossRes.isError).not.toBe(true);
    expect(
      (crossRes.structuredContent as { normalized_result: unknown })
        .normalized_result,
    ).toMatchObject({
      items: [
        { block: "DFDS", block_index: 1, stored_bytes: 3, source_index: 3 },
        { block: "LIvi", block_index: 2, stored_bytes: 1, source_index: 4 },
      ],
      coverage: { total: 5 },
    });

    const completeRes = await client.callTool({
      name: "inspect_labview_artifact",
      arguments: { path, detail: "complete" },
    });
    expect(completeRes.isError).not.toBe(true);
    const complete = completeRes.structuredContent as {
      normalized_result: { blocks: { identifier: string }[] };
    };
    expect(complete.normalized_result.blocks.map((b) => b.identifier)).toEqual([
      "LVSR",
      "DFDS",
      "LIvi",
    ]);
  });
});
