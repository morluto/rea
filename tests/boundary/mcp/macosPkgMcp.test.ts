import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { buildProductArchive } from "../../../src/artifacts/macosPkg/MacosPkg.fixture.js";

it.each(["compact"] as const)(
  "retains macOS installer package facts through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-macos-pkg-mcp-");
    const path = join(root, "fixture.pkg");
    const bytes = buildProductArchive();
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "session,artifact",
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: { kind: "archive", format: "pkg", architecture: null },
      });
      const reply = await call("inspect_artifact", {});
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      const inventory = inspection.substeps[0]!.evidence.normalized_result;
      expect(inventory.coverage.status).toBe("complete");
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: ".",
          format_metadata: expect.objectContaining({
            kind: "macos-pkg",
            archive_kind: "product",
            scripts: expect.objectContaining({
              preinstall: true,
              postinstall: true,
            }),
            signature: expect.objectContaining({
              verification: "not_verified",
            }),
          }),
        }),
      );
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(result.containment_verified).toBe(true);
      expect(
        (
          await readFile(
            join(outputRoot, "Component.pkg/Payload/usr/local/rea/hello.txt"),
          )
        ).toString("utf8"),
      ).toBe("hello from payload\n");
      expect((await readFile(path)).equals(bytes)).toBe(true);
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);
