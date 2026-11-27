import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import {
  peOverlayImage,
  ZIP_LOCAL_HEADER,
} from "../../../src/native/pe/PeOverlay.fixture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const overlayContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_pe_overlay",
);

mcpTest(
  "advertises and reads a PE overlay without executing or changing the image",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_pe_overlay",
      );
      if (definition === undefined)
        throw new Error("Missing advertised contract");
      expect(definition.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-pe-overlay-mcp-");
      const path = join(root, "app.exe");
      const bytes = peOverlayImage({ trailing: ZIP_LOCAL_HEADER });
      await writeFile(path, bytes);
      const response = await client.callTool(
        { name: "inspect_pe_overlay", arguments: { path } },
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = overlayContract.outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.parameters).toEqual({ path });
      expect(evidence.normalized_result.ranges).toEqual([
        expect.objectContaining({
          role: "other",
          offset: 0x400,
          size: ZIP_LOCAL_HEADER.length,
          sha256: sha256Hex(ZIP_LOCAL_HEADER),
          leading_format: "zip",
        }),
      ]);
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
      const tooSmall = await client.callTool(
        {
          name: "inspect_pe_overlay",
          arguments: { path, max_file_bytes: 64 },
        },
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
      expect(tooSmall.isError).toBe(true);
      const tooSmallText = tooSmall.content[0];
      expect(tooSmallText?.type).toBe("text");
      expect(
        JSON.parse(tooSmallText?.type === "text" ? tooSmallText.text : ""),
      ).toMatchObject({
        error: {
          code: "resource_constraint",
          details: {
            refusal: {
              kind: "adjustable_budget",
              operation: "inspect_pe_overlay",
              control: "max_file_bytes",
              effective_value: 64,
            },
          },
        },
      });
      const bad = await client.callTool(
        {
          name: "inspect_pe_overlay",
          arguments: { path: "relative.exe" },
        },
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
      expect(bad.isError).toBe(true);
    } finally {
      await session.close();
    }
  },
);
