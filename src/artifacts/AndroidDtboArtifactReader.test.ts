import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANDROID_DTBO_READER_LIMITS,
  type AndroidDtboReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { ANDROID_DTBO_MAGIC } from "../domain/firmware/androidDtboFormat.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/ArtifactReader.js";
import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import {
  buildSyntheticAndroidDtbo,
  sampleAndroidDtboV0,
  sampleAndroidDtboV1Mixed,
} from "../../tests/fixtures/androidDtbo.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AndroidDtboArtifactReader } from "./AndroidDtboArtifactReader.js";

async function writeTempImage(
  bytes: Buffer,
  name = "dtbo.img",
): Promise<string> {
  const dir = await createTestTempDirectory("rea-android-dtbo-reader-");
  const target = join(dir, name);
  await writeFile(target, bytes);
  return target;
}

async function readWithCoverage(reader: AndroidDtboArtifactReader): Promise<{
  entries: ArtifactEntry[];
  coverage: ArtifactReaderTraversal | undefined;
}> {
  const entries: ArtifactEntry[] = [];
  let coverage: ArtifactReaderTraversal | undefined;
  for await (const entry of reader.entries(undefined, {
    onCoverage: (observed) => {
      coverage = observed;
    },
  })) {
    entries.push(entry);
  }
  return { entries, coverage };
}

async function collectClosed(
  path: string,
  limits?: AndroidDtboReaderLimits,
): Promise<ArtifactEntry[]> {
  const reader = new AndroidDtboArtifactReader(path, undefined, limits);
  try {
    return await collectEntries(reader);
  } finally {
    await reader.close();
  }
}

describe("AndroidDtboArtifactReader", () => {
  it("lists and extracts valid v0 DTBO FDT entries with complete coverage", async () => {
    const fixture = sampleAndroidDtboV0();
    const imagePath = await writeTempImage(fixture.image);
    const reader = new AndroidDtboArtifactReader(imagePath);

    try {
      const { entries, coverage } = await readWithCoverage(reader);
      expect(entries.map((entry) => entry.path)).toEqual([
        "dtbo-0.dtbo",
        "dtbo-1.dtbo",
      ]);
      expect(reader.formatMetadata()).toEqual({
        kind: "android-dtbo",
        magic: ANDROID_DTBO_MAGIC,
        total_size: fixture.image.length,
        header_size: 32,
        dt_entry_size: 32,
        dt_entry_count: 2,
        dt_entries_offset: 32,
        page_size: 2048,
        version: 0,
        emitted_entry_count: 2,
      });

      expect(entries[0]?.formatMetadata).toEqual({
        kind: "android-dtbo-entry",
        index: 0,
        dt_size: fixture.entries[0]!.length,
        dt_offset: 96,
        id: 0x00000101,
        rev: 0x00010000,
        flags: null,
        compression: null,
        custom: [0x11111111, 0x22222222, 0x33333333, 0x44444444],
        fdt_magic_valid: true,
      });
      expect(entries[0]?.limitations).toEqual([]);
      expect(entries[1]?.limitations).toEqual([]);

      expect(coverage).toEqual({ status: "complete", limitations: [] });

      const firstExtracted = await buffer(await reader.open(entries[0]!));
      const secondExtracted = await buffer(await reader.open(entries[1]!));
      expect(firstExtracted.equals(fixture.entries[0]!)).toBe(true);
      expect(secondExtracted.equals(fixture.entries[1]!)).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("records explicit limitations for compressed v1 entries and invalid or short child magics", async () => {
    const mixed = sampleAndroidDtboV1Mixed();
    const shortPayload = Buffer.from([0xd0, 0x0d]);
    const image = buildSyntheticAndroidDtbo({
      version: 1,
      pageSize: 4096,
      entries: [
        {
          payload: mixed.plainOverlay,
          id: 1,
          rev: 1,
          flags: 0,
          custom: [10, 20, 30],
        },
        {
          payload: mixed.gzipPayload,
          id: 2,
          rev: 1,
          flags: 2,
          custom: [40, 50, 60],
        },
        {
          payload: mixed.nonFdtPayload,
          id: 3,
          rev: 1,
          flags: 0,
          custom: [70, 80, 90],
        },
        {
          payload: shortPayload,
          id: 4,
          rev: 1,
          flags: 0,
          custom: [100, 110, 120],
        },
      ],
    });
    const reader = new AndroidDtboArtifactReader(await writeTempImage(image));

    try {
      const { entries, coverage: traversal } = await readWithCoverage(reader);
      expect(entries).toHaveLength(4);
      expect(entries[0]!.formatMetadata).toMatchObject({
        fdt_magic_valid: true,
        compression: "none",
      });
      expect(entries[0]!.limitations).toEqual([]);

      expect(entries[1]!.formatMetadata).toMatchObject({
        fdt_magic_valid: null,
        compression: "gzip",
        flags: 2,
      });
      expect(entries[1]!.limitations[0]).toContain("gzip compression");

      expect(entries[2]!.formatMetadata).toMatchObject({
        fdt_magic_valid: false,
        compression: "none",
      });
      expect(entries[2]!.limitations[0]).toContain(
        "does not start with FDT magic 0xd00dfeed",
      );

      expect(entries[3]!.formatMetadata).toMatchObject({
        fdt_magic_valid: false,
      });
      expect(entries[3]!.limitations[0]).toContain(
        "shorter than the 4-byte FDT magic",
      );

      expect(await buffer(await reader.open(entries[1]!))).toEqual(
        mixed.gzipPayload,
      );
      expect(await buffer(await reader.open(entries[2]!))).toEqual(
        mixed.nonFdtPayload,
      );

      expect(traversal?.status).toBe("complete");
      expect(traversal?.limitations).toHaveLength(3);
    } finally {
      await reader.close();
    }
  });

  it("handles empty DTBO tables, extra header/entry bytes, omitted zero-size entries, and trailing padding", async () => {
    const emptyImage = buildSyntheticAndroidDtbo({
      entries: [],
      dtEntryCount: 0,
    });
    const emptyReader = new AndroidDtboArtifactReader(
      await writeTempImage(emptyImage, "empty.dtbo"),
    );
    try {
      const { entries, coverage: traversal } =
        await readWithCoverage(emptyReader);
      expect(entries).toEqual([]);
      expect(emptyReader.formatMetadata()?.emitted_entry_count).toBe(0);
      expect(traversal?.limitations[0]).toContain("dt_entry_count 0");
    } finally {
      await emptyReader.close();
    }

    const validBlob = sampleAndroidDtboV0().entries[0]!;
    const extendedImage = buildSyntheticAndroidDtbo({
      version: 1,
      headerSize: 64,
      dtEntrySize: 48,
      trailingBytes: Buffer.from("TAIL"),
      entries: [
        { payload: Buffer.alloc(0), dtSize: 0, dtOffset: 160, flags: 1 },
        { payload: validBlob, flags: 0, id: 77, rev: 3, custom: [1, 2, 3] },
      ],
    });
    const extendedReader = new AndroidDtboArtifactReader(
      await writeTempImage(extendedImage, "extended.dtbo"),
    );
    try {
      const { entries, coverage: traversal } =
        await readWithCoverage(extendedReader);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.path).toBe("dtbo-1.dtbo");
      expect(extendedReader.formatMetadata()?.dt_entry_count).toBe(2);
      expect(extendedReader.formatMetadata()?.emitted_entry_count).toBe(1);
      expect(traversal?.limitations).toHaveLength(4);
    } finally {
      await extendedReader.close();
    }
  });

  it("charges every row of a shared payload against expanded_bytes", async () => {
    // Three rows naming one 64-byte payload declare 192 readable bytes.
    const rows = 3;
    const payloadAt = 32 + rows * 32;
    const image = Buffer.alloc(payloadAt + 64);
    image.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    image.writeUInt32BE(image.length, 4);
    image.writeUInt32BE(32, 8);
    image.writeUInt32BE(32, 12);
    image.writeUInt32BE(rows, 16);
    image.writeUInt32BE(32, 20);
    for (let row = 0; row < rows; row++) {
      image.writeUInt32BE(64, 32 + row * 32);
      image.writeUInt32BE(payloadAt, 32 + row * 32 + 4);
    }
    const path = await writeTempImage(image);
    const admitted = new AndroidDtboArtifactReader(
      path,
      undefined,
      undefined,
      192,
    );
    try {
      expect(await collectEntries(admitted)).toHaveLength(rows);
    } finally {
      await admitted.close();
    }
    const refused = new AndroidDtboArtifactReader(
      path,
      undefined,
      undefined,
      191,
    );
    try {
      await expect(collectEntries(refused)).rejects.toMatchObject({
        reason: "limit",
        readerLimit: {
          parameter: "artifact_limits.expanded_bytes",
          effective_value: 191,
          required_value: 192,
        },
      });
    } finally {
      await refused.close();
    }
  });

  it("fails closed on corrupt, truncated, unsupported-version, overlapping, and over-limit inputs", async () => {
    const badMagic = buildSyntheticAndroidDtbo({
      magic: 0x01020304,
      entries: [],
    });
    await expect(
      collectClosed(await writeTempImage(badMagic)),
    ).rejects.toMatchObject({ reason: "malformed" });

    const truncated = sampleAndroidDtboV0().image.subarray(0, 64);
    await expect(
      collectClosed(await writeTempImage(truncated)),
    ).rejects.toMatchObject({ reason: "truncated" });

    const unsupported = buildSyntheticAndroidDtbo({ version: 9, entries: [] });
    await expect(
      collectClosed(await writeTempImage(unsupported)),
    ).rejects.toMatchObject({ reason: "unsupported" });

    const overlap = buildSyntheticAndroidDtbo({
      entries: [
        { dtOffset: 96, dtSize: 20, payload: Buffer.alloc(20, 0xd0) },
        { dtOffset: 108, dtSize: 20, payload: Buffer.alloc(20, 0xd0) },
      ],
      totalSize: 140,
    });
    await expect(
      collectClosed(await writeTempImage(overlap)),
    ).rejects.toMatchObject({ reason: "malformed" });

    const defaultCount = DEFAULT_ANDROID_DTBO_READER_LIMITS.entry_count;
    const overCountSize = 32 + (defaultCount + 1) * 32;
    const overCount = Buffer.alloc(overCountSize);
    overCount.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    overCount.writeUInt32BE(overCountSize, 4);
    overCount.writeUInt32BE(32, 8);
    overCount.writeUInt32BE(32, 12);
    overCount.writeUInt32BE(defaultCount + 1, 16);
    overCount.writeUInt32BE(32, 20);
    for (let i = 0; i < defaultCount + 1; i++) {
      overCount.writeUInt32BE(0, 32 + i * 32);
      overCount.writeUInt32BE(overCountSize, 32 + i * 32 + 4);
    }
    const overCountPath = await writeTempImage(overCount);
    await expect(collectClosed(overCountPath)).rejects.toMatchObject({
      reason: "limit",
      readerLimit: {
        parameter: "artifact_limits.android_dtbo.entry_count",
        effective_value: defaultCount,
        unit: "count",
        required_value: defaultCount + 1,
        can_increase: true,
      },
    });
    await expect(
      collectClosed(overCountPath, {
        ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
        entry_count: defaultCount + 1,
      }),
    ).resolves.toEqual([]);
  });
});
