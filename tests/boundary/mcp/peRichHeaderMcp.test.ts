import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  peRichHeaderImage,
  RICH_FIXTURE_ENTRIES,
} from "../../../src/native/pe/PeRichHeader.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

type BinaryDiagnosticsContract =
  (typeof BINARY_DIAGNOSTICS_TOOL_CONTRACTS)[number];
const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
  (
    candidate,
  ): candidate is Extract<
    BinaryDiagnosticsContract,
    { name: "inspect_pe_rich_header" }
  > => candidate.name === "inspect_pe_rich_header",
);
if (contract === undefined)
  throw new Error("Missing inspect_pe_rich_header contract");

mcpTest(
  "advertises and reads a PE Rich header without executing or changing the image",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_pe_rich_header",
      );
      if (definition === undefined)
        throw new Error("Missing advertised contract");
      expect(definition.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-pe-rich-mcp-");
      const path = join(root, "app.exe");
      const bytes = peRichHeaderImage();
      await writeFile(path, bytes);
      const response = await client.callTool(
        { name: "inspect_pe_rich_header", arguments: { path } },
        { toolDefinition: definition },
      );
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const report = contract.outputSchema.parse(
        response.structuredContent,
      ).normalized_result;
      expect(report.rich_header).toMatchObject({
        state: "present",
        checksum: { matches: true },
      });
      if (report.rich_header.state !== "present")
        throw new Error("Expected a Rich header");
      expect(report.rich_header.entries).toHaveLength(
        RICH_FIXTURE_ENTRIES.length,
      );
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
      const bad = await client.callTool(
        { name: "inspect_pe_rich_header", arguments: { path: "relative.exe" } },
        { toolDefinition: definition },
      );
      expect(bad.isError).toBe(true);
    } finally {
      await session.close();
    }
  },
  60_000,
);
