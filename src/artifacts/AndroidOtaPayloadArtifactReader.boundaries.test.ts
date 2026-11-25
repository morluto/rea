import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createHash } from "node:crypto";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import {
  androidOtaSignatureBlob,
  buildAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../domain/firmware/androidOtaPayload.fixture.js";
import {
  ANDROID_OTA_MAX_MANIFEST_BYTES,
  ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
  ANDROID_OTA_MAX_SIGNATURE_BYTES,
} from "../domain/firmware/androidOtaPayload.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-android-ota-boundary-"),
    "payload.bin",
  );
  await writeFile(path, bytes);
  return path;
};

it("reports the unsupported version at explicit OTA reader admission", async () => {
  const reader = new AndroidOtaPayloadArtifactReader(
    await fixture(v1AndroidOtaPayload()),
  );
  try {
    await expect(collectEntries(reader)).rejects.toMatchObject({
      reason: "unavailable",
      cause: {
        kind: "unsupported",
        message: expect.stringContaining("Android OTA payload major version 1"),
      },
    });
  } finally {
    await reader.close();
  }
});

it("applies the manifest allowance only when the declared bytes fit the file", async () => {
  const header = Buffer.alloc(24);
  header.write("CrAU", 0, "latin1");
  header.writeBigUInt64BE(2n, 4);
  const manifestSize = ANDROID_OTA_MAX_MANIFEST_BYTES + 1;
  header.writeBigUInt64BE(BigInt(manifestSize), 12);
  for (const offset of [0, 1]) {
    const path = await fixture(header);
    await truncate(path, header.length + manifestSize - offset);
    const reader = new AndroidOtaPayloadArtifactReader(path);
    try {
      await expect(collectEntries(reader)).rejects.toMatchObject(
        offset === 0
          ? { reason: "limit", boundary: "capacity" }
          : {
              reason: "truncated",
              parseFailure: {
                kind: "truncated",
                format: "android-ota-payload",
              },
            },
      );
    } finally {
      await reader.close();
    }
  }
});

it("keeps a complete manifest without reading a truncated oversized metadata signature", async () => {
  const metadataSignature = androidOtaSignatureBlob(
    Buffer.alloc(ANDROID_OTA_MAX_SIGNATURE_BYTES),
  );
  const image = buildAndroidOtaPayload({
    metadataSignature,
    partitions: [
      { name: "boot", operations: [{ type: 0, data: Buffer.from("BOOT") }] },
    ],
  });
  const manifestEnd = 24 + Number(image.readBigUInt64BE(12));
  const path = await fixture(
    image.subarray(0, manifestEnd + metadataSignature.length - 1),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidOtaPayloadArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    expect(await collectEntries(reader)).toMatchObject([{ path: "boot.img" }]);
    expect(reader.formatMetadata()).toMatchObject({
      blob_truncated: true,
      manifest_size: manifestEnd - 24,
      metadata_signature_size: metadataSignature.length,
      metadata_signature_count: null,
    });
    const ranges = reads.mock.calls.map(
      ([, , length, offset]: readonly unknown[]) => ({
        offset: Number(offset),
        end: Number(offset) + Number(length),
      }),
    );
    expect(ranges).toContainEqual({ offset: 24, end: manifestEnd });
    expect(ranges.every(({ end }) => end <= manifestEnd)).toBe(true);
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("refuses over-budget operation data before reading the sparse carrier body", async () => {
  const maximum = ANDROID_OTA_MAX_OPERATION_DATA_BYTES;
  const manifestOnly = buildAndroidOtaPayload({
    metadataSignature: new Uint8Array(),
    payloadSignature: new Uint8Array(),
    signaturesOffset: null,
    signaturesSize: null,
    partitions: [
      {
        name: "system",
        newSize: 4096,
        omitNewHash: true,
        operations: [
          {
            type: 0,
            dataLength: maximum + 1,
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  const path = await fixture(manifestOnly);
  await truncate(path, manifestOnly.length + maximum + 1);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidOtaPayloadArtifactReader(path, admitted);
  const read = vi.spyOn(admitted.handle, "read");
  try {
    const [entry] = await collectEntries(reader);
    if (entry === undefined) throw new Error("Expected the system partition");
    expect(entry.path).toBe("system.img");
    expect(read).toHaveBeenCalled();
    read.mockClear();
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      cause: { failure: { kind: "limit", limit: { maximum } } },
    });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("cancels a many-frame REPLACE_ZSTD partition", async () => {
  const frame = Buffer.from([
    0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x61,
  ]);
  const compressed = Buffer.alloc(frame.length * 32);
  for (let index = 0; index < 32; index += 1)
    frame.copy(compressed, index * frame.length);
  const path = await fixture(
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "vendor",
          operations: [
            {
              type: 14,
              data: compressed,
              dataHash: createHash("sha256").update(compressed).digest(),
              dstExtents: [{ startBlock: 0, numBlocks: 1 }],
            },
          ],
        },
      ],
    }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidOtaPayloadArtifactReader(path, admitted);
  const reason = new Error("stop ota frames");
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  try {
    const [entry] = await collectEntries(reader);
    await expect(reader.open(entry!, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  } finally {
    spy.mockRestore();
    try {
      await reader.close();
    } finally {
      await admitted.handle.close();
    }
  }
});

it("preserves cancellation while reconstructing a partition", async () => {
  const path = await fixture(
    buildAndroidOtaPayload({
      partitions: [
        {
          name: "boot",
          operations: [{ type: 0, data: Buffer.alloc(64 * 1024, 0x61) }],
        },
      ],
    }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidOtaPayloadArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel reconstruction");
  let reconstructing = false;
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (reconstructing) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    const [entry] = await collectEntries(reader);
    reconstructing = true;
    await expect(reader.open(entry!, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    reads.mockRestore();
    const recovered = await collectEntries(reader);
    expect(recovered).toHaveLength(1);
    expect(
      (await buffer(await reader.open(recovered[0]!))).subarray(0, 1)[0],
    ).toBe(0x61);
  } finally {
    try {
      await reader.close();
    } finally {
      reads.mockRestore();
      await admitted.handle.close();
    }
  }
});

artifactPreparationRecoveryCases({
  image: () => fullAndroidOtaPayload(),
  createReader: (path, admitted) =>
    new AndroidOtaPayloadArtifactReader(path, admitted),
});
