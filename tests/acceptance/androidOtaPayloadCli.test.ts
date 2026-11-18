import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import {
  deltaAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../../src/domain/firmware/androidOtaPayload.fixture.js";

cliTest(
  "inspects and extracts a full Android OTA payload through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-ota-cli-");
    const source = join(root, "payload.bin");
    await writeFile(source, fullAndroidOtaPayload());
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
    expect(graph.manifest.root_format).toBe("android-ota-payload");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-ota-payload",
      payload_kind: "full",
      signatures_verified: false,
      security_patch_level: "2024-01-05",
    });
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
      (await readFile(join(result.output_root, "boot.img")))
        .subarray(0, 7)
        .toString("latin1"),
    ).toBe("BOOTIMG");
  },
);

cliTest(
  "refuses a v1 Android OTA payload through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-ota-cli-v1-");
    const source = join(root, "payload.bin");
    await writeFile(source, v1AndroidOtaPayload());
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode).not.toBe(0);
    expect(`${inspected.stdout}\n${inspected.stderr}`).toContain("unsupported");
  },
);

cliTest(
  "inventories a delta Android OTA payload without extracting it",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-ota-cli-delta-");
    const source = join(root, "payload.bin");
    await writeFile(source, deltaAndroidOtaPayload());
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
    expect(graph.manifest.root_format).toBe("android-ota-payload");
    expect(
      graph.occurrences.find((row) => row.logical_path === "vendor.img"),
    ).toMatchObject({ hash_status: "unavailable" });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode).not.toBe(0);
  },
);
