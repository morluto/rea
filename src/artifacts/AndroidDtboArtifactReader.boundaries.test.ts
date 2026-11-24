import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANDROID_DTBO_READER_LIMITS,
  type AndroidDtboReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { ANDROID_DTBO_MAGIC } from "../domain/firmware/androidDtboFormat.js";
import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import {
  buildSyntheticAndroidDtbo,
  sampleAndroidDtboV0,
} from "../../tests/fixtures/androidDtbo.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AndroidDtboArtifactReader } from "./AndroidDtboArtifactReader.js";

async function writeBoundaryImage(bytes: Buffer): Promise<string> {
  const dir = await createTestTempDirectory("rea-dtbo-boundary-");
  const path = join(dir, "boundary.dtbo");
  await writeFile(path, bytes);
  return path;
}

async function readBoundaryInventory(
  path: string,
  limits?: AndroidDtboReaderLimits,
) {
  const reader = new AndroidDtboArtifactReader(path, undefined, limits);
  try {
    const entries = await collectEntries(reader);
    return { entries, metadata: reader.formatMetadata() };
  } finally {
    await reader.close();
  }
}

describe("AndroidDtboArtifactReader boundaries", () => {
  artifactReaderLifecycleCases({
    image: () => sampleAndroidDtboV0().image,
    createReader: (path, admitted) =>
      new AndroidDtboArtifactReader(path, admitted),
  });

  it("enforces adjustable entry_count at default and admits when raised", async () => {
    const defaultCount = DEFAULT_ANDROID_DTBO_READER_LIMITS.entry_count;
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

    const atDefaultPath = await writeBoundaryImage(buildAtCount(defaultCount));
    const atDefault = await readBoundaryInventory(atDefaultPath);
    expect(atDefault.entries).toEqual([]);
    expect(atDefault.metadata?.dt_entry_count).toBe(defaultCount);

    const aboveDefaultPath = await writeBoundaryImage(
      buildAtCount(defaultCount + 1),
    );
    await expect(readBoundaryInventory(aboveDefaultPath)).rejects.toMatchObject(
      {
        reason: "limit",
        readerLimit: {
          parameter: "artifact_limits.android_dtbo.entry_count",
          effective_value: defaultCount,
          unit: "count",
          required_value: defaultCount + 1,
          can_increase: true,
        },
      },
    );

    const raised = await readBoundaryInventory(aboveDefaultPath, {
      ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
      entry_count: defaultCount + 1,
    });
    expect(raised.metadata?.dt_entry_count).toBe(defaultCount + 1);
  });

  it("enforces adjustable entry_table_bytes and allows large headers within file bounds", async () => {
    const sample = sampleAndroidDtboV0().image;
    const samplePath = await writeBoundaryImage(sample);

    await expect(
      readBoundaryInventory(samplePath, {
        ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
        entry_table_bytes: 63,
      }),
    ).rejects.toMatchObject({
      reason: "limit",
      readerLimit: {
        parameter: "artifact_limits.android_dtbo.entry_table_bytes",
        effective_value: 63,
        unit: "bytes",
        required_value: 64,
        can_increase: true,
      },
    });

    const admittedTable = await readBoundaryInventory(samplePath, {
      ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
      entry_table_bytes: 64,
    });
    expect(admittedTable.entries).toHaveLength(2);

    const largeHeaderPath = await writeBoundaryImage(
      buildSyntheticAndroidDtbo({
        headerSize: 65_537,
        dtEntrySize: 4097,
        entries: [{ payload: sampleAndroidDtboV0().entries[0]! }],
      }),
    );
    const largeHeaderResult = await readBoundaryInventory(largeHeaderPath);
    expect(largeHeaderResult.entries).toHaveLength(1);
    expect(largeHeaderResult.metadata).toMatchObject({
      header_size: 65_537,
      dt_entry_size: 4097,
    });
  });
});
