import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, onTestFinished } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
const contract = (() => {
  const found = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_raw_raster_candidates",
  );
  if (found === undefined)
    throw new Error("Missing inspect_raw_raster_candidates contract");
  return found;
})();
const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());
import { mcpTest } from "../../support/mcp/mcpFixture.js";
mcpTest(
  "advertises and executes raw candidate search without a deep provider",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not acquire provider");
    });
    onTestFinished(async () => {
      const r = await session.close();
      if (!r.ok) throw r.error;
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
      undefined,
      schemaValidation,
    );
    const advertised = (await client.listTools()).tools.find(
      (t) => t.name === "inspect_raw_raster_candidates",
    );
    expect(advertised).toBeDefined();
    const root = await createTestTempDirectory("rea-raster-mcp-");
    const path = join(root, "bytes");
    await writeFile(
      path,
      Buffer.from(
        Array.from(
          { length: 512 },
          (_, i) => (i % 32) * 5 + Math.floor(i / 32) * 3,
        ),
      ),
    );
    const response = await client.callTool({
      name: "inspect_raw_raster_candidates",
      arguments: { path, widths: [32], heights: [16], formats: ["gray8"] },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const result = contract.outputSchema.parse(response.structuredContent);
    expect(session.evidenceById(result.evidence_id)).toEqual(result);
    expect(result.parameters).not.toHaveProperty("max_candidates");
    expect(result.normalized_result.resolved_controls).toBeDefined();
    expect(result.confidence).toBe("inferred");
    expect(result.normalized_result.candidates[0]?.layout.offset).toBe(0);
  },
);
