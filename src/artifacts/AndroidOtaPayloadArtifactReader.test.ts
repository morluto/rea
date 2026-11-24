import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { expect, it } from "vitest";

import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import { ArtifactEntryContentUnavailable } from "../resources/ArtifactReader.js";
import {
  buildAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../domain/firmware/androidOtaPayload.fixture.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-android-ota-"), name);
  await writeFile(path, bytes);
  return path;
};

it("distinguishes supported OTA payload bytes from opaque ZIP members", async () => {
  const archive = zipArchive([
    { name: "update.bin", data: fullAndroidOtaPayload(), method: 0 },
    { name: "old/payload.bin", data: v1AndroidOtaPayload(), method: 0 },
    { name: "notes/payload.bin", data: Buffer.from("nope"), method: 0 },
  ]);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("update.zip", archive),
  );
  expect(snapshot.manifest.root_format).toBe("zip");
  for (const [logical_path, artifact_format, artifact_kind] of [
    ["update.bin", "android-ota-payload", "container"],
    ["old/payload.bin", "file", "resource"],
    ["notes/payload.bin", "file", "resource"],
  ]) {
    expect(
      snapshot.occurrences.find((row) => row.logical_path === logical_path),
    ).toMatchObject({
      artifact_format,
      artifact_kind,
    });
  }
  expect(
    snapshot.occurrences.map(({ logical_path }) => logical_path).sort(),
  ).toEqual([".", "notes/payload.bin", "old/payload.bin", "update.bin"]);
});

it.each([
  ["outside", 1_700_000_000n, 1n << 53n, null],
  ["within", 1n << 53n, 1_700_000_000n, 1_700_000_000],
] as const)(
  "reports the last OTA timestamp when it is %s the exact integer range",
  async (_label, first, last, expected) => {
    const manifest = new BinaryWriter()
      .tag(14, WireType.Varint)
      .int64(first)
      .tag(14, WireType.Varint)
      .int64(last)
      .finish();
    const header = Buffer.alloc(24);
    header.write("CrAU");
    header.writeBigUInt64BE(2n, 4);
    header.writeBigUInt64BE(BigInt(manifest.length), 12);
    const snapshot = await scanCanonicalArtifactInventory(
      await writeCarrier("payload.bin", Buffer.concat([header, manifest])),
    );
    expect(
      snapshot.occurrences.find(({ logical_path }) => logical_path === "."),
    ).toMatchObject({
      format_metadata: { kind: "android-ota-payload", max_timestamp: expected },
    });
    expect(
      snapshot.limitations.some((note) => note.includes("max_timestamp")),
    ).toBe(expected === null);
  },
);

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
  const metadataBytes =
    Number(full.readBigUInt64BE(12)) + full.readUInt32BE(20);
  const truncated = full.subarray(0, 24 + metadataBytes + 1);
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
    kept.occurrences.filter(({ logical_path }) => logical_path !== "."),
  ).toMatchObject([
    { logical_path: "boot.img", hash_status: "unavailable" },
    { logical_path: "system.img", hash_status: "verified" },
  ]);
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
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (entry === undefined) throw new Error("Missing boot partition");
      expect(entry).toMatchObject({
        path: "boot.img",
        declaredIntegrity: null,
      });
      const opened = reader.open(entry).then(buffer);
      if (data === original) {
        expect((await opened).equals(original)).toBe(true);
      } else {
        await expect(opened).rejects.toMatchObject({
          reason: "integrity",
          integrityCheck: "declared-digest",
          message: expect.stringContaining("operation 0"),
        });
      }
    } finally {
      await reader.close();
    }
  }
});

it("retains payload header and partitions when optional trailing payloadSignature parsing fails", async () => {
  const path = await writeCarrier(
    "bad-trailing-sig.bin",
    buildAndroidOtaPayload({
      partitions: [
        { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
      ],
      // Invalid protobuf wire type 7 in optional trailing payload signature blob.
      payloadSignature: Buffer.from([0x0f, 0xff, 0xff, 0xff]),
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-ota-payload");
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "Optional trailing payload signature could not be parsed",
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "android-ota-payload",
    payload_signature_count: null,
    partitions: [{ name: "boot" }],
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "boot.img"),
  ).toMatchObject({ hash_status: "verified" });
});

it("refuses trailing payloadSignature blobs that exceed the fixed signature count limit", async () => {
  const writer = new BinaryWriter();
  for (let index = 0; index < 65; index += 1)
    writer.tag(1, WireType.LengthDelimited).bytes(new Uint8Array([index]));
  const path = await writeCarrier(
    "too-many-trailing-sigs.bin",
    buildAndroidOtaPayload({
      partitions: [
        { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
      ],
      payloadSignature: Buffer.from(writer.finish()),
    }),
  );
  const reader = new AndroidOtaPayloadArtifactReader(path);
  try {
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        // Expect refusal during preparation before yielding entries.
      }
    }).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      message: expect.stringContaining("signature count"),
    });
  } finally {
    await reader.close();
  }
  await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow(
    /signature count exceeds the fixed 64-signature ceiling/u,
  );
});
