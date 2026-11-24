import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_DTBO_MAGIC,
  ANDROID_DTBO_MAX_ENTRY_COUNT,
  ANDROID_DTBO_MAX_ENTRY_SIZE,
  ANDROID_DTBO_MAX_HEADER_SIZE,
} from "../domain/firmware/androidDtboFormat.js";
import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { sampleAndroidDtboV0 } from "../../tests/fixtures/androidDtbo.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AndroidDtboArtifactReader } from "./AndroidDtboArtifactReader.js";

async function writeBoundaryImage(bytes: Buffer): Promise<string> {
  const dir = await createTestTempDirectory("rea-dtbo-boundary-");
  const path = join(dir, "boundary.dtbo");
  await writeFile(path, bytes);
  return path;
}

describe("AndroidDtboArtifactReader boundaries", () => {
  artifactReaderLifecycleCases({
    image: () => sampleAndroidDtboV0().image,
    createReader: (path, admitted) =>
      new AndroidDtboArtifactReader(path, admitted),
  });

  it("accepts DTBO entry count at the ceiling and refuses one above", async () => {
    const buildAtCount = (count: number) => {
      const tableSize = count * 32;
      const totalSize = 32 + tableSize;
      const buf = Buffer.alloc(totalSize);
      buf.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
      buf.writeUInt32BE(totalSize, 4);
      buf.writeUInt32BE(32, 8);
      buf.writeUInt32BE(32, 12);
      buf.writeUInt32BE(count, 16);
      buf.writeUInt32BE(32, 20);
      buf.writeUInt32BE(2048, 24);
      buf.writeUInt32BE(0, 28);
      for (let i = 0; i < count; i++) {
        buf.writeUInt32BE(0, 32 + i * 32);
        buf.writeUInt32BE(totalSize, 32 + i * 32 + 4);
      }
      return buf;
    };

    const atCeiling = new AndroidDtboArtifactReader(
      await writeBoundaryImage(buildAtCount(ANDROID_DTBO_MAX_ENTRY_COUNT)),
    );
    try {
      const entries = await collectEntries(atCeiling);
      expect(entries).toEqual([]);
      expect(atCeiling.formatMetadata()?.dt_entry_count).toBe(
        ANDROID_DTBO_MAX_ENTRY_COUNT,
      );
    } finally {
      await atCeiling.close();
    }

    const aboveCeiling = new AndroidDtboArtifactReader(
      await writeBoundaryImage(buildAtCount(ANDROID_DTBO_MAX_ENTRY_COUNT + 1)),
    );
    try {
      await expect(collectEntries(aboveCeiling)).rejects.toMatchObject({
        reason: "limit",
        fixedAllowance: {
          name: "ANDROID_DTBO_MAX_ENTRY_COUNT",
          limit: ANDROID_DTBO_MAX_ENTRY_COUNT,
        },
      });
    } finally {
      await aboveCeiling.close();
    }
  });

  it("accepts DTBO header_size and dt_entry_size at ceiling and refuses one above", async () => {
    const buildWithHeader = (headerSize: number) => {
      const buf = Buffer.alloc(headerSize);
      buf.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
      buf.writeUInt32BE(headerSize, 4);
      buf.writeUInt32BE(headerSize, 8);
      buf.writeUInt32BE(32, 12);
      buf.writeUInt32BE(0, 16);
      buf.writeUInt32BE(headerSize, 20);
      return buf;
    };

    const okHeaderReader = new AndroidDtboArtifactReader(
      await writeBoundaryImage(buildWithHeader(ANDROID_DTBO_MAX_HEADER_SIZE)),
    );
    try {
      expect(await collectEntries(okHeaderReader)).toEqual([]);
    } finally {
      await okHeaderReader.close();
    }

    const overHeaderReader = new AndroidDtboArtifactReader(
      await writeBoundaryImage(
        buildWithHeader(ANDROID_DTBO_MAX_HEADER_SIZE + 1),
      ),
    );
    try {
      await expect(collectEntries(overHeaderReader)).rejects.toMatchObject({
        reason: "limit",
        fixedAllowance: { name: "ANDROID_DTBO_MAX_HEADER_SIZE" },
      });
    } finally {
      await overHeaderReader.close();
    }

    const buildWithEntrySize = (entrySize: number) => {
      const buf = Buffer.alloc(32 + entrySize);
      buf.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
      buf.writeUInt32BE(32 + entrySize, 4);
      buf.writeUInt32BE(32, 8);
      buf.writeUInt32BE(entrySize, 12);
      buf.writeUInt32BE(1, 16);
      buf.writeUInt32BE(32, 20);
      buf.writeUInt32BE(0, 32);
      buf.writeUInt32BE(32 + entrySize, 36);
      return buf;
    };

    const okEntryReader = new AndroidDtboArtifactReader(
      await writeBoundaryImage(buildWithEntrySize(ANDROID_DTBO_MAX_ENTRY_SIZE)),
    );
    try {
      expect(await collectEntries(okEntryReader)).toEqual([]);
    } finally {
      await okEntryReader.close();
    }

    const overEntryReader = new AndroidDtboArtifactReader(
      await writeBoundaryImage(
        buildWithEntrySize(ANDROID_DTBO_MAX_ENTRY_SIZE + 1),
      ),
    );
    try {
      await expect(collectEntries(overEntryReader)).rejects.toMatchObject({
        reason: "limit",
        fixedAllowance: { name: "ANDROID_DTBO_MAX_ENTRY_SIZE" },
      });
    } finally {
      await overEntryReader.close();
    }
  });
});
