import { buffer } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempFile } from "../../../tests/fixtures/temporaryDirectory.js";
import { recognizeArtifactFormat } from "../../domain/artifactFormatRecognition.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../../resources/index.js";
import {
  MediaAssetArtifactReader,
  type MediaAssetFormat,
} from "./MediaAssetArtifactReader.js";
import {
  bink2Fixture,
  oggOpusFixture,
  oggOpusSpannedTagsFixture,
  riffXma2Fixture,
  vulkanPipelineCacheFixture,
} from "./mediaAsset.fixture.js";

const write = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-media-asset-", name, bytes);

const read = async (format: MediaAssetFormat, bytes: Buffer) => {
  const reader = new MediaAssetArtifactReader(
    await write(`asset.${format}`, bytes),
    format,
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    const contents = new Map<string, Buffer>();
    for (const entry of entries)
      contents.set(entry.path, await buffer(await reader.open(entry)));
    return { entries, coverage, contents, metadata: reader.formatMetadata() };
  } finally {
    await reader.close();
  }
};

const regions = (entries: readonly ArtifactEntry[]) =>
  entries.map(({ path, byteOffset, declaredSize }) => ({
    path,
    byteOffset,
    declaredSize,
  }));

describe("media asset recognition", () => {
  it.each([
    ["ogg-opus", oggOpusFixture()],
    ["riff-xma2", riffXma2Fixture()],
    ["bink2", bink2Fixture()],
    ["vulkan-pipeline-cache", vulkanPipelineCacheFixture()],
  ] as const)("recognizes %s from its leading bytes", (format, bytes) => {
    expect(
      recognizeArtifactFormat({
        prefix: bytes.subarray(0, 4096),
        fileSize: bytes.length,
      }),
    ).toMatchObject({ state: "recognized", format });
  });

  it("does not claim a plain PCM WAVE as XMA2", () => {
    const bytes = riffXma2Fixture();
    bytes.writeUInt16LE(1, 20);
    expect(
      recognizeArtifactFormat({
        prefix: bytes.subarray(0, 4096),
        fileSize: bytes.length,
      })?.format,
    ).not.toBe("riff-xma2");
  });

  it("does not claim Ogg without OpusHead", () => {
    const bytes = oggOpusFixture();
    bytes.write("Vorbis\0\0", 28, "latin1");
    expect(
      recognizeArtifactFormat({
        prefix: bytes.subarray(0, 4096),
        fileSize: bytes.length,
      })?.format,
    ).not.toBe("ogg-opus");
  });
});

describe("Ogg Opus headers", () => {
  it("reports OpusHead facts, vendor and page regions", async () => {
    const bytes = oggOpusFixture();
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({
      kind: "ogg-opus",
      channel_count: 2,
      pre_skip: 312,
      input_sample_rate: 48_000,
      output_gain: 0,
      mapping_family: 0,
      vendor: "test",
      page_sequences: [0, 1],
      serials: [0x1234, 0x1234],
      extent_check: "consistent",
    });
    expect(regions(result.entries).map((row) => row.path)).toEqual([
      "pages/0.bin",
      "pages/1.bin",
      "audio.bin",
    ]);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it("reports a cut-off later page as truncated coverage after OpusHead", async () => {
    const whole = oggOpusFixture();
    // First page is complete; the second page header is cut mid-way.
    const first = 27 + whole[26]! + whole[27]!;
    const result = await read("ogg-opus", whole.subarray(0, first + 10));
    expect(result.metadata).toMatchObject({
      kind: "ogg-opus",
      channel_count: 2,
      vendor: null,
      pages_read: 1,
      extent_check: "truncated",
    });
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("keeps spanned OpusTags pages out of audio.bin", async () => {
    const bytes = oggOpusSpannedTagsFixture();
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({
      kind: "ogg-opus",
      vendor: "A".repeat(280),
      pages_read: 3,
      extent_check: "consistent",
    });
    expect(regions(result.entries).map((row) => row.path)).toEqual([
      "pages/0.bin",
      "pages/1.bin",
      "pages/2.bin",
      "audio.bin",
    ]);
    expect(result.contents.get("audio.bin")).toEqual(
      bytes.subarray(bytes.length - (27 + 1 + 3)),
    );
    expect(result.contents.get("audio.bin")?.includes(0xab)).toBe(true);
    expect(result.contents.get("audio.bin")?.includes(0x41)).toBe(false);
  });

  it("reports truncated when the first Ogg page payload is cut off", async () => {
    const whole = oggOpusFixture();
    const firstHeader = 27 + whole[26]!;
    const declaredPayload = whole[27]!;
    await expect(
      read("ogg-opus", whole.subarray(0, firstHeader + declaredPayload - 1)),
    ).rejects.toMatchObject({
      parseFailure: {
        kind: "truncated",
        format: "ogg-opus",
      },
    });
  });
});

describe("RIFF XMA2 headers", () => {
  it("reports fmt tag 0x166 fields, XMA2 extras and chunk regions", async () => {
    const result = await read("riff-xma2", riffXma2Fixture());
    expect(result.metadata).toMatchObject({
      kind: "riff-xma2",
      format_tag: 0x166,
      channels: 2,
      samples_per_sec: 48_000,
      block_align: 2048,
      bits_per_sample: 16,
      fmt_extra_bytes: 34,
      xma2: {
        num_streams: 1,
        channel_mask: 3,
        samples_encoded: 32_768,
        bytes_per_block: 0,
        play_begin: 0,
        play_length: 0,
        loop_begin: 0,
        loop_length: 0,
        loop_count: 4,
        encoder_version: 1,
        block_count: 1,
      },
      extent_check: "consistent",
      chunks: [
        { id: "fmt ", offset: 20, length: 52 },
        { id: "data", offset: 80, length: 4096 },
      ],
    });
    expect(regions(result.entries)).toEqual([
      { path: "chunks/0.fmt", byteOffset: 20, declaredSize: 52 },
      { path: "chunks/1.data", byteOffset: 80, declaredSize: 4096 },
    ]);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it("reports a truncated data chunk as a size mismatch while keeping declared chunk metadata", async () => {
    const whole = riffXma2Fixture(4096);
    const result = await read("riff-xma2", whole.subarray(0, 200));
    expect(result.metadata).toMatchObject({
      kind: "riff-xma2",
      extent_check: "truncated",
      chunks: [
        { id: "fmt ", offset: 20, length: 52 },
        { id: "data", offset: 80, length: 4096 },
      ],
    });
    expect(regions(result.entries)).toEqual([
      { path: "chunks/0.fmt", byteOffset: 20, declaredSize: 52 },
    ]);
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("reports a RIFF/XMA2 file cut inside its fmt chunk as truncated rather than missing", async () => {
    const whole = riffXma2Fixture(64);
    await expect(
      read("riff-xma2", whole.subarray(0, 40)),
    ).rejects.toMatchObject({
      parseFailure: {
        kind: "truncated",
        format: "riff-xma2",
        offset: 20,
      },
    });
  });

  it("reports a cut-off RIFF header as truncated rather than malformed", async () => {
    await expect(
      read("riff-xma2", Buffer.from("RIFFWAV", "latin1")),
    ).rejects.toMatchObject({
      parseFailure: {
        kind: "truncated",
        format: "riff-xma2",
        offset: 0,
        extent: { availableBytes: 7, requiredBytes: 12 },
      },
    });
  });

  it("does not invent WAVE members past the declared RIFF end", async () => {
    const base = riffXma2Fixture(64);
    const trailing = Buffer.concat([
      Buffer.from("LIST", "latin1"),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("adtl", "latin1"),
    ]);
    const bytes = Buffer.concat([base, trailing]);
    const result = await read("riff-xma2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "riff-xma2",
      extent_check: "trailing-bytes",
      chunks: [
        { id: "fmt ", offset: 20, length: 52 },
        { id: "data", offset: 80, length: 64 },
      ],
    });
    expect(regions(result.entries).map((row) => row.path)).toEqual([
      "chunks/0.fmt",
      "chunks/1.data",
    ]);
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("follow the last declared"),
      ),
    ).toBe(true);
  });

  it("treats a partial trailing chunk header inside the RIFF form as incomplete", async () => {
    const whole = riffXma2Fixture(64);
    // Shrink the declared RIFF size so the file ends mid-header after fmt.
    const bytes = Buffer.from(whole.subarray(0, 20 + 52 + 4));
    bytes.writeUInt32LE(bytes.length - 8, 4);
    const result = await read("riff-xma2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "riff-xma2",
      extent_check: "truncated",
      chunks: [{ id: "fmt ", offset: 20, length: 52 }],
    });
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("partial RIFF chunk header"),
      ),
    ).toBe(true);
  });
});

describe("Bink 2 headers", () => {
  it("reports revision, frames, dimensions, fps and the offset table", async () => {
    const bytes = bink2Fixture(10);
    const tableBytes = 44;
    const tableOffset = 44;
    const framesOffset = tableOffset + tableBytes;
    const expectedTable = bytes.subarray(tableOffset, framesOffset);
    const expectedFrames = bytes.subarray(framesOffset);
    expect(bytes.length).toBe(44 + tableBytes + 10 * 0x40);
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "bink2",
      revision: "j".charCodeAt(0),
      revision_char: "j",
      frame_count: 10,
      width: 1280,
      height: 720,
      fps_numerator: 30,
      fps_denominator: 1,
      frame_offset_table_offset: tableOffset,
      frame_offset_table_bytes: tableBytes,
      extent_check: "consistent",
    });
    expect(regions(result.entries)).toEqual([
      {
        path: "frame-offsets.bin",
        byteOffset: tableOffset,
        declaredSize: tableBytes,
      },
      {
        path: "frames.bin",
        byteOffset: framesOffset,
        declaredSize: expectedFrames.length,
      },
    ]);
    expect(result.contents.get("frame-offsets.bin")).toEqual(expectedTable);
    expect(result.contents.get("frames.bin")).toEqual(expectedFrames);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it("reports a truncated frame-offset table without inventing frame bytes", async () => {
    const result = await read("bink2", bink2Fixture(10).subarray(0, 60));
    expect(result.metadata).toMatchObject({
      kind: "bink2",
      extent_check: "truncated",
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([]);
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("reports a cut-off Bink 2 header as truncated rather than malformed", async () => {
    await expect(
      read("bink2", Buffer.from("KB2j\0\0\0\0", "latin1")),
    ).rejects.toMatchObject({
      parseFailure: {
        kind: "truncated",
        format: "bink2",
        offset: 0,
        extent: { availableBytes: 8, requiredBytes: 44 },
      },
    });
  });
});

describe("Vulkan pipeline cache headers", () => {
  it("reports VersionOne facts and an opaque body", async () => {
    const result = await read(
      "vulkan-pipeline-cache",
      vulkanPipelineCacheFixture(),
    );
    expect(result.metadata).toMatchObject({
      kind: "vulkan-pipeline-cache",
      header_size: 32,
      header_version: 1,
      vendor_id: 0x1002,
      device_id: 0x73bf,
      pipeline_cache_uuid: "000102030405060708090a0b0c0d0e0f",
      opaque_offset: 32,
      opaque_bytes: 2000,
      extent_check: "consistent",
    });
    expect(regions(result.entries)).toEqual([
      { path: "header.bin", byteOffset: 0, declaredSize: 32 },
      { path: "opaque.bin", byteOffset: 32, declaredSize: 2000 },
    ]);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it("refuses a VersionOne claim when headerSize is not 32", async () => {
    const bytes = vulkanPipelineCacheFixture();
    bytes.writeUInt32LE(40, 0);
    await expect(read("vulkan-pipeline-cache", bytes)).rejects.toMatchObject({
      parseFailure: {
        kind: "malformed",
        format: "vulkan-pipeline-cache",
        offset: 0,
      },
    });
  });

  it("reports a cut-off Vulkan pipeline cache header as truncated rather than malformed", async () => {
    const prefix = vulkanPipelineCacheFixture().subarray(0, 16);
    await expect(read("vulkan-pipeline-cache", prefix)).rejects.toMatchObject({
      parseFailure: {
        kind: "truncated",
        format: "vulkan-pipeline-cache",
        offset: 0,
        extent: { availableBytes: 16, requiredBytes: 32 },
      },
    });
  });
});
