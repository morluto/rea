import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  ESP32C3_APP_SEGMENTS,
  ESP32C3_BOOTLOADER_SEGMENTS,
  esp8266Image,
  espImage,
} from "../fixtures/espImage.js";
import { ESP8266_REFUSAL } from "../../src/domain/firmware/espImage.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

const cases = [
  {
    role: "app",
    bytes: espImage({ segments: ESP32C3_APP_SEGMENTS }),
    segments: [
      "segment-00.bin",
      "segment-01.bin",
      "segment-02.bin",
      "segment-03.bin",
    ],
  },
  {
    role: "bootloader",
    bytes: espImage({ segments: ESP32C3_BOOTLOADER_SEGMENTS }),
    segments: ["segment-00.bin", "segment-01.bin"],
  },
] as const;

cliTest.for(cases)(
  "inventories and extracts an ESP $role image through the compiled CLI",
  async ({ role, bytes, segments }, { cli }) => {
    const directory = await createTestTempDirectory("rea-esp-cli-");
    const source = join(directory, `${role}.bin`);
    await writeFile(source, bytes);
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
    expect(graph.manifest.root_format).toBe("esp-image");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "esp-image",
      descriptor: { kind: role },
      checksum: { status: "valid" },
    });
    expect(
      graph.occurrences
        .filter((row) => row.logical_path !== ".")
        .map((row) => row.logical_path),
    ).toEqual(segments);
    expect(inspection.next_probes).toEqual([]);
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    onTestFinished(() =>
      rm(result.output_root, { recursive: true, force: true }),
    );
    expect(result.containment_verified).toBe(true);
    const first = graph.occurrences.find(
      (row) => row.logical_path === segments[0],
    )?.source_location;
    if (first === null || first === undefined)
      throw new Error("Missing segment location");
    expect(
      Buffer.compare(
        await readFile(join(result.output_root, segments[0])),
        bytes.subarray(first.offset, first.offset + first.length),
      ),
    ).toBe(0);
  },
);

cliTest("refuses an ESP8266 image through the CLI", async ({ cli }) => {
  const directory = await createTestTempDirectory("rea-esp8266-cli-");
  const source = join(directory, "esp8266.bin");
  await writeFile(source, esp8266Image());
  const result = await cli.run({
    arguments: ["inspect-artifact", source, "--json"],
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(ESP8266_REFUSAL);
});
