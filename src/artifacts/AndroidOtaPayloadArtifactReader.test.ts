import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import { ArtifactEntryContentUnavailable } from "../resources/ArtifactReader.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import {
  buildAndroidOtaPayload,
  deltaAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../domain/firmware/androidOtaPayload.fixture.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-android-ota-"), name);
  await writeFile(path, bytes);
  return path;
};

it("classifies OTA payload bytes as a container by magic, not by suffix", () => {
  expect(
    classifyArtifactBytesAtPath("update.bin", fullAndroidOtaPayload()),
  ).toEqual({
    kind: "container",
    format: "android-ota-payload",
  });
  expect(
    classifyArtifactBytesAtPath("payload.bin", Buffer.from("nope")),
  ).toEqual({
    kind: "resource",
    format: "file",
  });
  expect(
    classifyArtifactBytesAtPath("payload.bin", v1AndroidOtaPayload()),
  ).toEqual({
    kind: "resource",
    format: "file",
  });
});

it("classifies a nested payload.bin member by CrAU magic", async () => {
  const nested = fullAndroidOtaPayload();
  expect(classifyArtifactBytesAtPath("ota/payload.bin", nested)).toEqual({
    kind: "container",
    format: "android-ota-payload",
  });
  const archive = zipArchive([
    { name: "payload.bin", data: nested, method: 0 },
  ]);
  expect(classifyArtifactBytesAtPath("update.zip", archive)).toEqual({
    kind: "container",
    format: "zip",
  });
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("update.zip", archive),
  );
  expect(snapshot.manifest.root_format).toBe("zip");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "payload.bin"),
  ).toMatchObject({
    artifact_format: "android-ota-payload",
    artifact_kind: "container",
  });
});

it("inventories full-payload partitions, groups, signatures and extractable images", async () => {
  const bytes = fullAndroidOtaPayload();
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("payload.bin", bytes),
  );
  expect(snapshot.manifest.root_format).toBe("android-ota-payload");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations.join(" ")).toContain("not verified");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({
    artifact_kind: "container",
    format_metadata: {
      kind: "android-ota-payload",
      magic: "CrAU",
      major_version: 2,
      payload_kind: "full",
      signatures_verified: false,
      snapshot_enabled: true,
      vabc_enabled: true,
      security_patch_level: "2024-01-05",
    },
  });
  expect(root?.format_metadata).toMatchObject({
    kind: "android-ota-payload",
    dynamic_partition_groups: [{ name: "super", partition_names: ["system"] }],
    apex_info: [{ package_name: "com.android.runtime" }],
  });
  const members = snapshot.occurrences.filter(
    (row) => row.logical_path !== ".",
  );
  expect(members.map((row) => [row.logical_path, row.hash_status])).toEqual([
    ["boot.img", "verified"],
    ["system.img", "verified"],
  ]);
  expect(members[0]?.format_metadata).toMatchObject({
    kind: "android-ota-partition",
    name: "boot",
    extractable: true,
  });
});

it("inventories a delta payload and leaves non-extractable partitions unread", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("delta.bin", deltaAndroidOtaPayload()),
  );
  expect(snapshot.manifest.root_format).toBe("android-ota-payload");
  const vendor = snapshot.occurrences.find(
    (row) => row.logical_path === "vendor.img",
  );
  expect(vendor).toMatchObject({
    hash_status: "unavailable",
    format_metadata: {
      kind: "android-ota-partition",
      extractable: false,
      operation_counts: [
        { type: "SOURCE_COPY", type_code: 4, count: 1 },
        { type: "BROTLI_BSDIFF", type_code: 10, count: 1 },
      ],
    },
  });
  expect(vendor?.limitations.join(" ")).toContain("not applied");
});

it("extracts reconstructed REPLACE and ZERO images", async () => {
  const path = await writeCarrier("payload.bin", fullAndroidOtaPayload());
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "android-ota-payload",
      outputRoot: join(path, "..", "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    const boot = await readFile(join(extracted.output_root, "boot.img"));
    expect(boot.subarray(0, 7).toString("latin1")).toBe("BOOTIMG");
    const system = await readFile(join(extracted.output_root, "system.img"));
    expect(system.equals(Buffer.alloc(8192))).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("refuses to extract a delta partition", async () => {
  const path = await writeCarrier("delta.bin", deltaAndroidOtaPayload());
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    await expect(reader.open(entries[0]!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
  } finally {
    await reader.close();
  }
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "android-ota-payload",
        outputRoot: join(path, "..", "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("vendor.img"),
    });
  } finally {
    await resourceScope.close();
  }
});

it("keeps the manifest when a partition exceeds the extraction limit", async () => {
  const path = await writeCarrier(
    "large.bin",
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          operations: [{ type: 0, data: Buffer.from("KERNEL") }],
        },
        {
          name: "system",
          newSize: 64 * 1024 * 1024,
          newHash: Buffer.alloc(32, 0xaa),
          operations: [
            { type: 6, dstExtents: [{ startBlock: 0, numBlocks: 1 }] },
          ],
        },
      ],
    }),
  );
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const system = entries.find((entry) => entry.path === "system.img");
    await expect(reader.open(system!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
  } finally {
    await reader.close();
  }
  const kept = await scanCanonicalArtifactInventory(path);
  expect(kept.manifest.root_format).toBe("android-ota-payload");
  expect(
    kept.occurrences.find((row) => row.logical_path === ".")?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    partitions: [{ name: "boot" }, { name: "system" }],
  });
  expect(
    kept.occurrences.find((row) => row.logical_path === "system.img")
      ?.hash_status,
  ).toBe("unavailable");
});

it("keeps partition inventory when the blob is truncated", async () => {
  const full = fullAndroidOtaPayload();
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("payload.bin", full),
  );
  const blobOffset = snapshot.occurrences.find(
    (row) => row.logical_path === ".",
  )?.format_metadata;
  expect(blobOffset?.kind).toBe("android-ota-payload");
  if (blobOffset?.kind !== "android-ota-payload") return;
  const truncated = full.subarray(0, blobOffset.blob_offset + 1);
  const kept = await scanCanonicalArtifactInventory(
    await writeCarrier("truncated.bin", truncated),
  );
  expect(kept.manifest.root_format).toBe("android-ota-payload");
  expect(kept.coverage.status).toBe("unknown");
  expect(kept.limitations.join(" ")).toContain("truncated");
  expect(
    kept.occurrences.find((row) => row.logical_path === ".")?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    blob_truncated: true,
    partitions: [{ name: "boot" }, { name: "system" }],
  });
  expect(
    kept.occurrences.find((row) => row.logical_path === "boot.img")
      ?.hash_status,
  ).toBe("unavailable");
});

it("streams a reconstructed partition whose hash matches the manifest", async () => {
  const path = await writeCarrier(
    "boot.bin",
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          operations: [{ type: 0, data: Buffer.from("KERNEL") }],
        },
      ],
    }),
  );
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    const listed = [];
    for await (const item of reader.entries()) listed.push(item);
    const [entry] = listed;
    const bytes = await buffer(await reader.open(entry!));
    expect(bytes.subarray(0, 6).toString("latin1")).toBe("KERNEL");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      entry?.declaredIntegrity && "digest" in entry.declaredIntegrity
        ? entry.declaredIntegrity.digest
        : "",
    );
  } finally {
    await reader.close();
  }
});

it("applies the caller's integrity policy to a partition hash mismatch", async () => {
  const path = await writeCarrier(
    "mismatch.bin",
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          newHash: Buffer.alloc(32, 0xff),
          operations: [{ type: 0, data: Buffer.from("KERNEL") }],
        },
      ],
    }),
  );
  await expect(scanCanonicalArtifactInventory(path)).rejects.toMatchObject({
    reason: "integrity",
  });
  const recorded = await scanCanonicalArtifactInventory(path, {
    integrity: "record-and-continue",
  });
  expect(
    recorded.occurrences.find((row) => row.logical_path === "boot.img"),
  ).toMatchObject({ hash_status: "mismatched" });
  expect(recorded.integrity_contradictions).toEqual([
    expect.objectContaining({
      logical_path: "boot.img",
      trust: "observed-untrusted",
    }),
  ]);
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "android-ota-payload",
      outputRoot: join(path, "..", "out"),
      environment: process.env,
      integrityPolicy: "record-and-continue",
      resourceScope,
    });
    const boot = await readFile(join(extracted.output_root, "boot.img"));
    expect(boot.subarray(0, 6).toString("latin1")).toBe("KERNEL");
    expect(extracted.integrity_contradictions).toEqual([
      expect.objectContaining({ logical_path: "boot.img" }),
    ]);
  } finally {
    await resourceScope.close();
  }
});

it("checks the stored OTA operation bytes when a partition hash is absent", async () => {
  const original = Buffer.from("BOOT");
  const dataHash = createHash("sha256").update(original).digest();
  for (const data of [original, Buffer.from("BOAT")]) {
    const path = await writeCarrier(
      "payload.bin",
      buildAndroidOtaPayload({
        partitions: [
          {
            name: "boot",
            omitNewHash: true,
            operations: [{ type: 0, data, dataHash }],
          },
        ],
      }),
    );
    const reader = new AndroidOtaPayloadArtifactReader(path);
    try {
      for await (const entry of reader.entries()) {
        expect(entry.path).toBe("boot.img");
        const opened = reader.open(entry).then(buffer);
        if (data === original) {
          expect((await opened).equals(original)).toBe(true);
        } else {
          await expect(opened).rejects.toMatchObject({
            reason: "integrity",
            message: expect.stringContaining("operation 0"),
          });
        }
      }
    } finally {
      await reader.close();
    }
  }
});
