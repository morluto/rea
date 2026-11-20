import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { ANDROID_OTA_MAX_SIGNATURE_BYTES } from "../../src/domain/firmware/androidOtaPayload.js";
import {
  androidOtaSignatureBlob,
  buildAndroidOtaPayload,
  deltaAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../../src/domain/firmware/androidOtaPayload.fixture.js";

cliTest.for([
  { signaturesOffset: 0, signaturesSize: null },
  {
    signaturesOffset: null,
    signaturesSize: ANDROID_OTA_MAX_SIGNATURE_BYTES + 1,
  },
])(
  "preserves one declared OTA signature field and extracts the partition ($signaturesOffset, $signaturesSize)",
  async ({ signaturesOffset, signaturesSize }, { cli }) => {
    const root = await createTestTempDirectory("rea-ota-signature-field-cli-");
    const source = join(root, "payload.bin");
    const data = Buffer.from("BOOT");
    await writeFile(
      source,
      buildAndroidOtaPayload({
        signaturesOffset,
        signaturesSize,
        payloadSignature: new Uint8Array(),
        partitions: [{ name: "boot", operations: [{ type: 0, data }] }],
      }),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-ota-payload",
      signatures_offset: signaturesOffset,
      signatures_size: signaturesSize,
      payload_signature_blob_size: null,
      payload_signature_count: null,
    });
    expect(
      graph.occurrences.find((row) => row.logical_path === "boot.img")
        ?.hash_status,
    ).toBe("verified");
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(
      (await readFile(join(result.output_root, "boot.img"))).equals(data),
    ).toBe(true);
  },
);

cliTest(
  "retains verified operation data beside an incomplete oversized payload signature",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-ota-truncated-signature-cli-",
    );
    const source = join(root, "payload.bin");
    const payloadSignature = androidOtaSignatureBlob(
      Buffer.alloc(ANDROID_OTA_MAX_SIGNATURE_BYTES),
    );
    const image = buildAndroidOtaPayload({
      payloadSignature,
      partitions: [
        { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
      ],
    });
    await writeFile(source, image);
    const complete = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(complete.exitCode).toBe(1);
    expect(complete.json).toMatchObject({
      details: { reason: "limit", boundary: "capacity" },
    });

    await writeFile(source, image.subarray(0, -1));
    const incomplete = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(incomplete.exitCode, incomplete.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(incomplete.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      blob_truncated: true,
      payload_signature_blob_size: payloadSignature.length,
      payload_signature_count: null,
    });
    expect(
      graph.occurrences.find((row) => row.logical_path === "boot.img")
        ?.hash_status,
    ).toBe("verified");
  },
);

cliTest(
  "retains split partition metadata in either order and extracts verified bytes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ota-partition-info-cli-");
    const source = join(root, "payload.bin");
    const partitions = ["boot", "vendor"].map((name, index) => {
      const data = Buffer.from(name);
      const hash = createHash("sha256").update(data).digest();
      const oldSize = data.length + 1;
      const oldHash = Buffer.alloc(32, 0xab + index);
      const previous = [{ size: oldSize }, { hash: oldHash }];
      const next = [{ size: data.length }, { hash }];
      return {
        name,
        data,
        hash,
        oldSize,
        oldHash,
        oldInfoFragments: index === 0 ? previous : previous.toReversed(),
        newInfoFragments: index === 0 ? next : next.toReversed(),
        operations: [{ type: 0, data }],
      };
    });
    const bytes = buildAndroidOtaPayload({ partitions });
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    for (const { name, data, hash, oldSize, oldHash } of partitions) {
      expect(
        graph.occurrences.find((row) => row.logical_path === `${name}.img`),
        `${name} partition metadata`,
      ).toMatchObject({
        hash_status: "verified",
        format_metadata: {
          new_partition_info: {
            size: data.length,
            hash_hex: hash.toString("hex"),
          },
          old_partition_info: {
            size: oldSize,
            hash_hex: oldHash.toString("hex"),
          },
        },
      });
    }
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    for (const { name, data } of partitions) {
      const extractedBytes = await readFile(
        join(result.output_root, `${name}.img`),
      );
      expect(extractedBytes.equals(data), `${name} extracted bytes`).toBe(true);
    }
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
    const graph = inspection.substeps[0]!.evidence.normalized_result;
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
    const graph = inspection.substeps[0]!.evidence.normalized_result;
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
    const graph = inspection.substeps[0]!.evidence.normalized_result;
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
