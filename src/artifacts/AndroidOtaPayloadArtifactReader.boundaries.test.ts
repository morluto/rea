import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
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

const entries = async (reader: AndroidOtaPayloadArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it("refuses a v1 payload as unavailable rather than as a container", async () => {
  const reader = new AndroidOtaPayloadArtifactReader(
    await fixture(v1AndroidOtaPayload()),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "unavailable",
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
      await expect(entries(reader)).rejects.toMatchObject(
        offset === 0
          ? { reason: "limit", boundary: "capacity" }
          : { reason: "format", cause: { kind: "truncated" } },
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
    expect(await entries(reader)).toMatchObject([{ path: "boot.img" }]);
    expect(reader.formatMetadata()).toMatchObject({
      blob_truncated: true,
      metadata_signature_count: null,
    });
    for (const [, , length, offset] of reads.mock
      .calls as readonly (readonly unknown[])[]) {
      expect(Number(length) + Number(offset)).toBeLessThanOrEqual(manifestEnd);
    }
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("streams a mismatched REPLACE partition and leaves its declared hash to the scanner", async () => {
  const reader = new AndroidOtaPayloadArtifactReader(
    await fixture(
      buildAndroidOtaPayload({
        partitions: [
          {
            name: "boot",
            newHash: Buffer.alloc(32, 0xaa),
            operations: [{ type: 0, data: Buffer.from("BOOT") }],
          },
        ],
      }),
    ),
  );
  try {
    const [entry] = await entries(reader);
    expect(entry?.declaredIntegrity).toEqual({
      algorithm: "sha256",
      digest: "aa".repeat(32),
    });
    const bytes = await buffer(await reader.open(entry!));
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("BOOT");
  } finally {
    await reader.close();
  }
});

it("refuses to open a partition whose distinct operation data exceeds the read budget", async () => {
  const reader = new AndroidOtaPayloadArtifactReader(
    await fixture(
      buildAndroidOtaPayload({
        partitions: [
          {
            name: "system",
            newSize: 4096,
            operations: [
              {
                type: 0,
                data: Buffer.alloc(
                  ANDROID_OTA_MAX_OPERATION_DATA_BYTES + 1,
                  0x41,
                ),
                dstExtents: [{ startBlock: 0, numBlocks: 1 }],
              },
            ],
          },
        ],
      }),
    ),
  );
  try {
    const listed = await entries(reader);
    await expect(reader.open(listed[0]!)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
    });
  } finally {
    await reader.close();
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
    const [entry] = await entries(reader);
    reconstructing = true;
    await expect(reader.open(entry!, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    reads.mockRestore();
    const recovered = await entries(reader);
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
