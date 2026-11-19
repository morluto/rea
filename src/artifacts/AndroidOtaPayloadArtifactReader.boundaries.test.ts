import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { AndroidOtaPayloadArtifactReader } from "./AndroidOtaPayloadArtifactReader.js";
import {
  buildAndroidOtaPayload,
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../domain/firmware/androidOtaPayload.fixture.js";
import {
  ANDROID_OTA_MAX_MANIFEST_BYTES,
  ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
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

it("reports an oversize declared manifest as a capacity limit", async () => {
  const bytes = Buffer.alloc(24);
  bytes.write("CrAU", 0, "latin1");
  bytes.writeBigUInt64BE(2n, 4);
  bytes.writeBigUInt64BE(BigInt(ANDROID_OTA_MAX_MANIFEST_BYTES + 1), 12);
  const reader = new AndroidOtaPayloadArtifactReader(await fixture(bytes));
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
    });
  } finally {
    await reader.close();
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
    const [entry] = await entries(reader);
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
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (args[3] !== 0) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    const [entry] = await entries(reader);
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
