import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  buildAndroidOtaPayload,
  deltaAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../../src/domain/firmware/androidOtaPayload.fixture.js";

cliTest.for([false, true])(
  "retains split partition metadata and extracts verified bytes (hash first: %s)",
  async (hashFirst, { cli }) => {
    const root = await createTestTempDirectory("rea-ota-partition-info-cli-");
    const source = join(root, "payload.bin");
    const data = Buffer.from("BOOT");
    const hash = createHash("sha256").update(data).digest();
    const fragments = hashFirst
      ? [{ hash }, { size: data.length }]
      : [{ size: data.length }, { hash }];
    const bytes = buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          oldInfoFragments: fragments,
          newInfoFragments: fragments,
          operations: [{ type: 0, data }],
        },
      ],
    });
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
    expect(
      graph.occurrences.find((row) => row.logical_path === "boot.img"),
    ).toMatchObject({
      hash_status: "verified",
      format_metadata: {
        new_partition_info: {
          size: data.length,
          hash_hex: hash.toString("hex"),
        },
        old_partition_info: {
          size: data.length,
          hash_hex: hash.toString("hex"),
        },
      },
    });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(
      (await readFile(join(result.output_root, "boot.img"))).equals(data),
    ).toBe(true);
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "enforces a split declared hash through shared integrity policies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ota-split-hash-cli-");
    const source = join(root, "payload.bin");
    const data = Buffer.from("BOOT");
    const bytes = buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          newInfoFragments: [
            { hash: Buffer.alloc(32, 0xab) },
            { size: data.length },
          ],
          operations: [{ type: 0, data }],
        },
      ],
    });
    await writeFile(source, bytes);
    const environment = { TMPDIR: root, TMP: root, TEMP: root };
    const refused = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "artifact_integrity_mismatch",
      details: {
        logical_path: "boot.img",
        declared_sha256: "ab".repeat(32),
        calculated_sha256: createHash("sha256").update(data).digest("hex"),
      },
    });
    expect(await readdir(root)).toEqual(["payload.bin"]);
    const recorded = await cli.run({
      arguments: [
        "inspect-artifact",
        source,
        "--integrity-policy",
        "record-and-continue",
        "--json",
      ],
    });
    expect(recorded.exitCode, recorded.stdout + recorded.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(recorded.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.integrity_contradictions).toEqual([
      expect.objectContaining({
        logical_path: "boot.img",
        declared_sha256: "ab".repeat(32),
        observed_sha256: createHash("sha256").update(data).digest("hex"),
        trust: "observed-untrusted",
      }),
    ]);
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);

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
