import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ANDROID_SPARSE_HEADER_SIZE } from "../../../src/domain/androidSparseImageFormat.js";
import { artifactInventorySummarySchema } from "../../../src/domain/analysisView/artifactInventoryView.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { buildAndroidSparseImage } from "../../fixtures/androidSparseImage.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["compact"] as const)(
  "inspects, summarizes, and extracts Android sparse images through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-android-sparse-mcp-");
    const rawSlice = Buffer.alloc(4096, 0x5c);
    rawSlice.write("SPARSE_MCP_SLICE", 32, "utf8");
    const sparseBytes = buildAndroidSparseImage({
      chunks: [
        { kind: "raw", data: rawSlice },
        { kind: "fill", blocks: 65_536, pattern: 0x00ff00ff },
        { kind: "dont_care", blocks: 65_536 },
      ],
    });
    const imagePath = join(root, "super-synthetic.img");
    await writeFile(imagePath, sparseBytes);

    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "session,artifact",
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
    });

    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path: imagePath });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: {
          kind: "archive",
          format: "android-sparse-image",
          architecture: null,
        },
      });

      const inspected = await call("inspect_artifact", {});
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(inspected.structuredContent).normalized_result,
      );
      const inventory = inspection.substeps[0]!.evidence.normalized_result;
      expect(inventory.coverage.status).toBe("complete");
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: ".",
          format_metadata: expect.objectContaining({
            kind: "android-sparse-image",
            unsparsed_size: (1 + 65_536 + 65_536) * 4096,
            raw_chunk_count: 1,
            fill_chunk_count: 1,
            dont_care_chunk_count: 1,
          }),
        }),
      );
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: "chunks/chunk-0000-raw.bin",
          source_location: {
            offset: ANDROID_SPARSE_HEADER_SIZE + 12,
            length: 4096,
          },
        }),
      );
      expect(inventory.nodes).toContainEqual(
        expect.objectContaining({
          sha256: createHash("sha256").update(rawSlice).digest("hex"),
        }),
      );

      const summaryReply = await call("inspect_artifact", {
        detail: "summary",
      });
      expect(summaryReply.isError, JSON.stringify(summaryReply)).not.toBe(true);
      const summaryContent = summaryReply.structuredContent as {
        normalized_result: { kind: string; summary: unknown };
      };
      expect(summaryContent.normalized_result.kind).toBe("summary");
      const summary = artifactInventorySummarySchema.parse(
        summaryContent.normalized_result.summary,
      );
      expect(summary.manifest.root_format).toBe("android-sparse-image");
      expect(summary.available_hash_status_counts).toBeDefined();
      expect(summary.root_format_metadata).toMatchObject({
        kind: "android-sparse-image-summary",
        chunk_count: 3,
      });

      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const extraction = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = extraction.output_root;
      expect(extraction.containment_verified).toBe(true);
      expect(
        (await readFile(join(outputRoot, "chunks/chunk-0000-raw.bin"))).equals(
          rawSlice,
        ),
      ).toBe(true);
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined) {
        await rm(outputRoot, { recursive: true, force: true });
      }
    }
  },
);
