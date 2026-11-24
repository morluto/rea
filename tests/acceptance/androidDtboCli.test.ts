import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import {
  ANDROID_DTBO_MAGIC,
  ANDROID_DTBO_MAX_ENTRY_COUNT,
} from "../../src/domain/firmware/androidDtboFormat.js";
import {
  buildSyntheticAndroidDtbo,
  sampleAndroidDtboV0,
  sampleAndroidDtboV1Mixed,
} from "../fixtures/androidDtbo.js";

cliTest(
  "inventories, extracts, and follows up v0 Android DTBO images into inspect-devicetree through the compiled CLI",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-android-dtbo-cli-");
    const source = join(directory, "dtbo.img");
    const fixture = sampleAndroidDtboV0();
    await writeFile(source, fixture.image);

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

    expect(graph.manifest.root_format).toBe("android-dtbo");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-dtbo",
      magic: ANDROID_DTBO_MAGIC,
      total_size: fixture.image.length,
      header_size: 32,
      dt_entry_size: 32,
      dt_entry_count: 2,
      dt_entries_offset: 32,
      page_size: 2048,
      version: 0,
      emitted_entry_count: 2,
    });

    expect(
      graph.occurrences
        .filter((row) => row.logical_path !== ".")
        .map((row) => row.logical_path),
    ).toEqual(["dtbo-0.dtbo", "dtbo-1.dtbo"]);

    expect(inspection.next_probes.map((probe) => probe.operation)).toEqual([
      "extract_artifact",
      "inspect_devicetree",
    ]);

    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const extractedResult = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    onTestFinished(() =>
      rm(extractedResult.output_root, { recursive: true, force: true }),
    );
    expect(extractedResult.containment_verified).toBe(true);

    const firstOut = join(extractedResult.output_root, "dtbo-0.dtbo");
    const secondOut = join(extractedResult.output_root, "dtbo-1.dtbo");
    expect((await readFile(firstOut)).equals(fixture.entries[0]!)).toBe(true);
    expect((await readFile(secondOut)).equals(fixture.entries[1]!)).toBe(true);

    const dtInspected = await cli.run({
      arguments: ["inspect-devicetree", firstOut, "--json"],
    });
    expect(dtInspected.exitCode, dtInspected.stdout + dtInspected.stderr).toBe(
      0,
    );
    expect(dtInspected.stdout).toContain("example,dtbo-overlay-a");
  },
);

cliTest(
  "surfaces v1 DTBO compression/magic limitations and rejects over-limit DTBO tables cleanly",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-android-dtbo-v1-cli-");
    const mixed = sampleAndroidDtboV1Mixed();
    const mixedPath = join(directory, "dtbo-v1.img");
    await writeFile(mixedPath, mixed.image);

    const inspected = await cli.run({
      arguments: ["inspect-artifact", mixedPath, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);

    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === "dtbo-1.dtbo")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-dtbo-entry",
      compression: "gzip",
      fdt_magic_valid: false,
    });
    expect(
      graph.occurrences.find((row) => row.logical_path === "dtbo-2.dtbo")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-dtbo-entry",
      compression: "none",
      fdt_magic_valid: false,
    });
    expect(
      graph.limitations.some((line) => line.includes("gzip compression")),
    ).toBe(true);
    expect(graph.limitations.some((line) => line.includes("0xd00dfeed"))).toBe(
      true,
    );

    const overCountSize = 32 + (ANDROID_DTBO_MAX_ENTRY_COUNT + 1) * 32;
    const overLimit = Buffer.alloc(overCountSize);
    overLimit.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    overLimit.writeUInt32BE(overCountSize, 4);
    overLimit.writeUInt32BE(32, 8);
    overLimit.writeUInt32BE(32, 12);
    overLimit.writeUInt32BE(ANDROID_DTBO_MAX_ENTRY_COUNT + 1, 16);
    overLimit.writeUInt32BE(32, 20);
    const overLimitPath = join(directory, "over-limit.dtbo");
    await writeFile(overLimitPath, overLimit);

    const refused = await cli.run({
      arguments: ["inspect-artifact", overLimitPath, "--json"],
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain(
      "ANDROID_DTBO_MAX_ENTRY_COUNT",
    );

    const badTable = buildSyntheticAndroidDtbo({
      entries: [
        { dtOffset: 96, dtSize: 20, payload: Buffer.alloc(20, 0xd0) },
        { dtOffset: 108, dtSize: 20, payload: Buffer.alloc(20, 0xd0) },
      ],
      totalSize: 140,
    });
    const badPath = join(directory, "overlap.dtbo");
    await writeFile(badPath, badTable);
    const malformed = await cli.run({
      arguments: ["inspect-artifact", badPath, "--json"],
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr + malformed.stdout).toContain("overlaps");
  },
);
