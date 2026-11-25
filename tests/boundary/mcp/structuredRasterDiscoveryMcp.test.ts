import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, onTestFinished } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { structuredRasterFixture } from "../../fixtures/structuredRaster.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
const contract = (() => {
  const found = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_structured_raster_candidates",
  );
  if (found === undefined)
    throw new Error("Missing inspect_structured_raster_candidates contract");
  return found;
})();
const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());
mcpTest(
  "advertises structured grammar and preserves caller logical segments through MCP",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("No deep provider");
    });
    onTestFinished(async () => {
      const r = await session.close();
      if (!r.ok) throw r.error;
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
      undefined,
      validation,
    );
    const root = await createTestTempDirectory("rea-structured-mcp-"),
      path = join(root, "bytes"),
      bytes = structuredRasterFixture();
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "inspect_structured_raster_candidates",
      arguments: {
        path,
        segments: [
          { logicalOffset: 10000, fileOffset: 0, length: bytes.length },
        ],
        max_previews: 1,
        max_resources: 2,
      },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    expect(response.content.some((block) => block.type === "image")).toBe(true);
    const evidence = contract.outputSchema.parse(response.structuredContent);
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    expect(evidence.normalized_result.mapping.logicalBase).toBe(10000);
    expect(evidence.normalized_result.tables[0]?.offset).toBe(10000);
    expect(evidence.normalized_result.projection).toMatchObject({
      returnedResources: 2,
      nextResourceOffset: 2,
      previews: 1,
    });
  },
);
