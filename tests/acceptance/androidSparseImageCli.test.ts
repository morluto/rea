import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  ANDROID_SPARSE_CHUNK_TYPE_RAW,
  ANDROID_SPARSE_HEADER_SIZE,
  ANDROID_SPARSE_MAGIC,
} from "../../src/domain/androidSparseImageFormat.js";
import { artifactInventorySummarySchema } from "../../src/domain/analysisView/artifactInventoryView.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { buildAndroidSparseImage } from "../fixtures/androidSparseImage.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inspects, summarizes, and extracts Android sparse images through the compiled CLI without materializing virtual blocks",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-cli-");
    const rawPayload = Buffer.alloc(4096, 0x7e);
    rawPayload.write("ANDROID_SPARSE_SYNTHETIC_EXT4", 1024, "utf8");

    const imageBytes = buildAndroidSparseImage({
      minorVersion: 0,
      imageChecksum: 0x0badc0de,
      chunks: [
        { kind: "fill", blocks: 262_144, pattern: 0xa5a55a5a }, // 1 GiB virtual fill
        { kind: "raw", data: rawPayload },
        { kind: "dont_care", blocks: 524_288 }, // 2 GiB virtual dont_care
        { kind: "crc32", crc32: 0x13579bdf },
      ],
    });
    const source = join(root, "vendor-synthetic.img");
    await writeFile(source, imageBytes);

    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);

    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.manifest.root_format).toBe("android-sparse-image");
    expect(graph.coverage.status).toBe("complete");

    const rootOccurrence = graph.occurrences.find(
      (row) => row.logical_path === ".",
    );
    expect(rootOccurrence?.format_metadata).toMatchObject({
      kind: "android-sparse-image",
      magic: ANDROID_SPARSE_MAGIC,
      major_version: 1,
      minor_version: 0,
      file_header_size: ANDROID_SPARSE_HEADER_SIZE,
      block_size: 4096,
      total_blocks: 262_144 + 1 + 524_288,
      total_chunks: 4,
      image_checksum: 0x0badc0de,
      unsparsed_size: (262_144 + 1 + 524_288) * 4096,
      raw_chunk_count: 1,
      fill_chunk_count: 1,
      dont_care_chunk_count: 1,
      crc32_chunk_count: 1,
      raw_data_bytes: 4096,
      virtual_fill_bytes: 262_144 * 4096,
      virtual_dont_care_bytes: 524_288 * 4096,
      crc32_verified: false,
      crc32_chunk_values: [0x13579bdf],
    });

    const rawOccurrence = graph.occurrences.find(
      (row) => row.logical_path === "chunks/chunk-0001-raw.bin",
    );
    expect(rawOccurrence).toMatchObject({
      source_location: {
        offset: ANDROID_SPARSE_HEADER_SIZE + 16 + 12,
        length: 4096,
      },
      format_metadata: {
        kind: "android-sparse-chunk",
        chunk_index: 1,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_RAW,
        output_block_offset: 262_144,
        output_byte_offset: 262_144 * 4096,
        output_blocks: 1,
        output_bytes: 4096,
      },
    });

    const expectedSha256 = createHash("sha256")
      .update(rawPayload)
      .digest("hex");
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        sha256: expectedSha256,
        size: 4096,
      }),
    );

    const evidenceBundle = join(root, "sparse-evidence.json");
    const summarized = await cli.run({
      arguments: [
        "inspect-artifact",
        source,
        "--detail",
        "summary",
        "--evidence_output",
        evidenceBundle,
        "--json",
      ],
    });
    expect(summarized.exitCode, summarized.stdout + summarized.stderr).toBe(0);
    const summaryPayload = summarized.json as {
      summary: { normalized_result: { kind: string; summary: unknown } };
    };
    expect(summaryPayload.summary.normalized_result.kind).toBe("summary");
    const summary = artifactInventorySummarySchema.parse(
      summaryPayload.summary.normalized_result.summary,
    );
    expect(summary.manifest.root_format).toBe("android-sparse-image");
    expect(summary.available_hash_status_counts).toBeDefined();
    expect(summary.root_format_metadata).toMatchObject({
      kind: "android-sparse-image-summary",
      chunk_count: 4,
      crc32_value_count: 1,
      raw_chunk_count: 1,
      fill_chunk_count: 1,
      dont_care_chunk_count: 1,
      unsparsed_size: (262_144 + 1 + 524_288) * 4096,
    });

    const outputRoot = join(root, "extracted");
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        source,
        "--output-root",
        outputRoot,
        "--json",
      ],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const extraction = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(extraction.containment_verified).toBe(true);
    expect(extraction.artifacts).toEqual([
      expect.objectContaining({
        relative_path: "chunks/chunk-0001-raw.bin",
        bytes_written: 4096,
        sha256: expectedSha256,
      }),
    ]);
    const written = await readFile(
      join(outputRoot, "chunks/chunk-0001-raw.bin"),
    );
    expect(written.equals(rawPayload)).toBe(true);
  },
);

cliTest(
  "refuses malformed, truncated, and budget-exceeding Android sparse images and recovers when artifact_limits is raised",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-bad-cli-");

    const mismatchPath = join(root, "bad-blocks.img");
    await writeFile(
      mismatchPath,
      buildAndroidSparseImage({
        totalBlks: 99,
        chunks: [{ kind: "dont_care", blocks: 1 }],
      }),
    );
    const mismatch = await cli.run({
      arguments: ["inspect-artifact", mismatchPath, "--json"],
    });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.json).toMatchObject({
      code: "unsupported_target",
      details: {
        format: "android-sparse-image",
        field: "total_blks",
      },
    });

    const truncatedPath = join(root, "truncated.img");
    const valid = buildAndroidSparseImage({
      chunks: [{ kind: "raw", data: Buffer.alloc(4096, 0x11) }],
    });
    await writeFile(truncatedPath, valid.subarray(0, valid.length - 64));
    const truncated = await cli.run({
      arguments: ["inspect-artifact", truncatedPath, "--json"],
    });
    expect(truncated.exitCode).toBe(1);
    expect(truncated.json).toMatchObject({
      code: "truncated",
      details: {
        format: "android-sparse-image",
        field: "chunk_payload",
      },
    });

    // Impossible total_chunks exceeding file bytes must fail non-retryably as truncated.
    const spoofedPath = join(root, "spoofed-chunks.img");
    await writeFile(
      spoofedPath,
      buildAndroidSparseImage({ totalChunks: 0xffff_ffff }),
    );
    const spoofed = await cli.run({
      arguments: ["inspect-artifact", spoofedPath, "--json"],
    });
    expect(spoofed.exitCode).toBe(1);
    expect(spoofed.json).toMatchObject({
      code: "truncated",
      retryable: false,
      details: {
        format: "android-sparse-image",
        field: "total_chunks",
      },
    });

    // Valid sparse image exceeding configured chunk_count fails retryably and recovers once raised.
    const boundedPath = join(root, "bounded-chunks.img");
    await writeFile(
      boundedPath,
      buildAndroidSparseImage({
        chunks: [
          { kind: "dont_care", blocks: 1 },
          { kind: "fill", blocks: 2, pattern: 0x11223344 },
          { kind: "dont_care", blocks: 3 },
        ],
      }),
    );
    const refused = await cli.run({
      arguments: [
        "inspect-artifact",
        boundedPath,
        "--artifact-limits",
        JSON.stringify({ android_sparse: { chunk_count: 2 } }),
        "--json",
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "truncated",
      retryable: true,
      details: {
        reader_limit: {
          parameter: "artifact_limits.android_sparse.chunk_count",
          effective_value: 2,
          required_value: 3,
          unit: "count",
          can_increase: true,
        },
      },
    });

    const recovered = await cli.run({
      arguments: [
        "inspect-artifact",
        boundedPath,
        "--artifact-limits",
        JSON.stringify({ android_sparse: { chunk_count: 3 } }),
        "--json",
      ],
    });
    expect(recovered.exitCode, recovered.stdout + recovered.stderr).toBe(0);
    const recoveredGraph = artifactInventoryResultSchema.parse(
      artifactInspectionResultSchema.parse(
        parseEvidence(recovered.json).normalized_result,
      ).substeps[0]?.evidence.normalized_result,
    );
    expect(recoveredGraph.manifest.root_format).toBe("android-sparse-image");
    expect(recoveredGraph.effective_limits).toMatchObject({
      android_sparse: { chunk_count: 3 },
    });
  },
);
