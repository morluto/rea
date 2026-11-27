import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { fileLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  MIXED_ANDROID_SPARSE_EXPANDED,
  buildAndroidSparseImage,
  mixedAndroidSparseImage,
} from "../../../src/domain/firmware/androidSparseImage.fixture.js";

const mcp = fileLocalToolsMcp({
  REA_MCP_TOOL_FAMILIES: "session,artifact",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
});

it("retains Android sparse image facts through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-android-sparse-mcp-");
  const path = join(root, "system.img");
  await writeFile(path, mixedAndroidSparseImage());
  const { call } = mcp;
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: {
        kind: "archive",
        format: "android-sparse-image",
        architecture: null,
      },
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
          kind: "android-sparse-image",
          expanded_size: 16,
          checksums_verified: false,
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
      (await readFile(join(result.output_root, "image.raw"))).equals(
        MIXED_ANDROID_SPARSE_EXPANDED,
      ),
    ).toBe(true);
  } finally {
    if (outputRoot !== undefined) await rm(outputRoot, { recursive: true });
  }
});

it("refuses a major version 2 sparse image through compiled MCP open_binary", async () => {
  const root = await createTestTempDirectory("rea-android-sparse-mcp-v2-");
  const path = join(root, "system.img");
  await writeFile(path, buildAndroidSparseImage({ majorVersion: 2 }));
  const { call } = mcp;
  const opened = await call("open_binary", { path });
  expect(opened.isError).toBe(true);
  expect(JSON.stringify(opened)).toContain("unsupported");
});

it("refuses a chunk table above the selected budget and admits it on retry through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-android-sparse-mcp-chunks-");
  const path = join(root, "system.img");
  await writeFile(path, mixedAndroidSparseImage());
  const { call } = mcp;
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const refused = await call("inspect_artifact", {
    artifact_limits: { android_sparse_image: { chunk_count: 3 } },
  });
  expect(parseMcpToolError(refused).error).toMatchObject({
    code: "partial",
    retryable: true,
    details: {
      reader_limit: {
        parameter: "artifact_limits.android_sparse_image.chunk_count",
        effective_value: 3,
        unit: "count",
        required_value: 4,
        can_increase: true,
        update_mode: "parameter",
      },
    },
  });
  const selected = { android_sparse_image: { chunk_count: 4 } };
  const reply = await call("inspect_artifact", { artifact_limits: selected });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const evidence = parseEvidence(reply.structuredContent);
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  const inventory = inspection.substeps[0]!.evidence.normalized_result;
  expect(inventory.coverage.status).toBe("complete");
  expect(inventory.effective_limits).toMatchObject(selected);
  expect(inventory.occurrences).toContainEqual(
    expect.objectContaining({
      logical_path: ".",
      format_metadata: expect.objectContaining({ total_chunks: 4 }),
    }),
  );
});
