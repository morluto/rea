import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import {
  MIXED_ANDROID_SPARSE_EXPANDED,
  buildAndroidSparseImage,
  mixedAndroidSparseImage,
} from "../../src/domain/firmware/androidSparseImage.fixture.js";

cliTest(
  "inspects an Android sparse image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-cli-");
    const source = join(root, "system.img");
    const bytes = mixedAndroidSparseImage();
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    expect(graph.manifest.root_format).toBe("android-sparse-image");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-sparse-image",
      block_size: 4,
      expanded_size: 16,
      checksums_verified: false,
      chunk_counts: { raw: 1, fill: 1, dont_care: 1, crc32: 1 },
    });
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "extracts an Android sparse image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-cli-");
    const source = join(root, "system.img");
    const bytes = mixedAndroidSparseImage();
    await writeFile(source, bytes);
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    expect(
      (await readFile(join(result.output_root, "image.raw"))).equals(
        MIXED_ANDROID_SPARSE_EXPANDED,
      ),
    ).toBe(true);
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "refuses a sparse image whose chunks do not add up to total_blks",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-cli-bad-");
    const source = join(root, "system.img");
    await writeFile(
      source,
      buildAndroidSparseImage({
        blockSize: 4,
        totalBlocks: 3,
        chunks: [{ type: "dont-care", blocks: 2 }],
      }),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode).toBe(1);
    expect(`${inspected.stdout}\n${inspected.stderr}`).toContain("total_blks");
  },
);

cliTest(
  "refuses a chunk table above the selected budget and admits it on retry through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-sparse-cli-");
    const source = join(root, "system.img");
    const bytes = mixedAndroidSparseImage();
    await writeFile(source, bytes);
    const command = ["inspect-artifact", source, "--json"];
    const refused = await cli.run({
      arguments: [
        ...command,
        "--artifact-limits",
        '{"android_sparse_image":{"chunk_count":3}}',
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "partial",
      retryable: true,
      details: {
        reader_limit: {
          parameter: "artifact_limits.android_sparse_image.chunk_count",
          effective_value: 3,
          required_value: 4,
          can_increase: true,
          update_mode: "parameter",
        },
      },
    });
    const recovered = await cli.run({
      arguments: [
        ...command,
        "--artifact-limits",
        '{"android_sparse_image":{"chunk_count":4}}',
      ],
    });
    expect(recovered.exitCode, recovered.stdout + recovered.stderr).toBe(0);
    const evidence = parseEvidence(recovered.json);
    const inventory = artifactInspectionResultSchema.parse(
      evidence.normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    expect(inventory.effective_limits).toMatchObject({
      android_sparse_image: { chunk_count: 4 },
    });
    expect(
      inventory.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({ total_chunks: 4 });
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);
