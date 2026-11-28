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
import { oggOpusLayout } from "./MediaAssetLayouts.js";
import {
  bink2Fixture,
  oggOpusFixture,
  oggPage,
  opusHeadPacket,
  opusTagsPacket,
  oggOpusManyTagsPagesFixture,
  oggOpusSpannedTagsFixture,
  riffXma2Fixture,
  vulkanPipelineCacheFixture,
} from "./mediaAsset.fixture.js";

const write = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-media-asset-", name, bytes);

const read = async (
  format: MediaAssetFormat,
  bytes: Buffer,
  limits?: { readonly region_count: number },
) => {
  const reader = new MediaAssetArtifactReader(
    await write(`asset.${format}`, bytes),
    format,
    undefined,
    limits,
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

  it("inventories many OpusTags continuation pages by position without reading comment payloads", async () => {
    const tagPages = 48;
    const bytes = oggOpusManyTagsPagesFixture(tagPages);
    expect(bytes.length).toBeGreaterThan(190_000);
    const result = await read("ogg-opus", bytes, {
      region_count: tagPages + 4,
    });
    expect(result.metadata).toMatchObject({
      kind: "ogg-opus",
      vendor: "short",
      pages_read: tagPages + 2,
      extent_check: "consistent",
    });
    expect(result.entries).toHaveLength(tagPages + 3);
    const audio = result.contents.get("audio.bin");
    expect(audio?.includes(0xab)).toBe(true);
    expect(audio?.includes(0x5a)).toBe(false);

    let totalReadBytes = 0;
    let maxReadLength = 0;
    const layout = await oggOpusLayout(
      bytes.subarray(0, 64),
      bytes.length,
      async (offset, length) => {
        const chunk = bytes.subarray(offset, offset + length);
        totalReadBytes += chunk.length;
        maxReadLength = Math.max(maxReadLength, chunk.length);
        return chunk;
      },
      { region_count: tagPages + 4 },
    );
    expect(layout.metadata.vendor).toBe("short");
    expect(layout.regions).toHaveLength(tagPages + 3);
    expect(maxReadLength).toBeLessThanOrEqual(12 + 4096);
    expect(totalReadBytes).toBeLessThan(16_384);
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
        extent: {
          availableBytes: firstHeader + declaredPayload - 1,
          requiredBytes: firstHeader + declaredPayload,
        },
      },
    });
  });

  it("reads OpusTags from the OpusHead stream across another stream's pages", async () => {
    const bytes = Buffer.concat([
      oggPage(0, 0n, opusHeadPacket(), 2),
      oggPage(0, 0n, Buffer.from("other-stream-header"), 2, {
        serial: 0x9999,
      }),
      oggPage(1, 0n, opusTagsPacket(Buffer.from("enc")), 0),
      oggPage(2, 960n, Buffer.from([0xfc, 1, 2]), 4),
    ]);
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({
      vendor: "enc",
      serials: [0x1234, 0x9999, 0x1234],
      pages_read: 3,
    });
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("belong to other logical streams"),
      ),
    ).toBe(true);
  });

  it("reports an OpusTags vendor that is not UTF-8 instead of dropping it silently", async () => {
    const bytes = Buffer.concat([
      oggPage(0, 0n, opusHeadPacket(), 2),
      oggPage(1, 0n, opusTagsPacket(Buffer.from([0xff, 0xfe])), 0),
    ]);
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({ vendor: null });
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("not valid UTF-8"),
      ),
    ).toBe(true);
  });

  it("reports an OpusHead page without the beginning-of-stream flag", async () => {
    const bytes = Buffer.concat([
      oggPage(0, 0n, opusHeadPacket(), 0),
      oggPage(1, 0n, opusTagsPacket(Buffer.from("enc")), 0),
    ]);
    const result = await read("ogg-opus", bytes);
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("beginning-of-stream flag"),
      ),
    ).toBe(true);
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

describe("RIFF chunk framing", () => {
  const riff = (chunks: readonly Buffer[]): Buffer => {
    const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length, 0);
    return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
  };
  const chunk = (id: string, payload: Buffer): Buffer => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length, 0);
    return Buffer.concat([Buffer.from(id, "latin1"), size, payload]);
  };
  const fmt = (): Buffer => riffXma2Fixture().subarray(12, 12 + 8 + 52);

  it("keeps an odd final chunk whose pad byte is omitted at the form end", async () => {
    const bytes = riff([fmt(), chunk("data", Buffer.from([1, 2, 3]))]);
    const result = await read("riff-xma2", bytes);
    expect(result.metadata).toMatchObject({ extent_check: "consistent" });
    expect(
      result.contents.get("chunks/1.data")?.equals(Buffer.from([1, 2, 3])),
    ).toBe(true);
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("without its pad byte"),
      ),
    ).toBe(true);
  });

  it("names a chunk with a non-alphanumeric FourCC by index, keeping its ID", async () => {
    const bytes = riff([fmt(), chunk("../x", Buffer.from([7, 7]))]);
    const result = await read("riff-xma2", bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.fmt",
      "chunks/1.bin",
    ]);
    expect(result.metadata).toMatchObject({
      chunks: [{ id: "fmt " }, { id: "../x" }],
    });
  });
});

describe("Bink 2 header offsets", () => {
  it("reads header words at the offsets FFmpeg's Bink demuxer uses", async () => {
    // Known-answer header written field by field at absolute offsets, so it
    // does not share the fixture builder's field order.
    const bytes = Buffer.alloc(48 + 3 * 4 + 0x20);
    bytes.write("KB2j", 0, "latin1");
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(2, 8); // frame count
    bytes.writeUInt32LE(0x11, 12); // largest frame size
    bytes.writeUInt32LE(0xdead_beef, 16); // unnamed word
    bytes.writeUInt32LE(640, 20); // width
    bytes.writeUInt32LE(360, 24); // height
    bytes.writeUInt32LE(24_000, 28); // fps numerator
    bytes.writeUInt32LE(1001, 32); // fps denominator
    bytes.writeUInt32LE(0x10, 36); // video flags
    bytes.writeUInt32LE(0, 40); // audio tracks
    bytes.writeUInt32LE(0xffff_ffff, 44); // revision j extra word
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      frame_count: 2,
      largest_frame_size: 0x11,
      width: 640,
      height: 360,
      fps_numerator: 24_000,
      fps_denominator: 1001,
      video_flags: 0x10,
      audio_track_count: 0,
      audio_tracks: [],
      frame_offset_table_offset: 48,
      frame_offset_table_bytes: 12,
    });
    expect(regions(result.entries)).toEqual([
      { path: "frame-offsets.bin", byteOffset: 48, declaredSize: 12 },
      { path: "frames.bin", byteOffset: 60, declaredSize: 0x20 },
    ]);
  });
});

describe("Bink 2 headers", () => {
  it("reports revision, frames, dimensions, fps and the offset table", async () => {
    const bytes = bink2Fixture(10);
    const tableBytes = 44;
    const tableOffset = 48;
    const framesOffset = tableOffset + tableBytes;
    const expectedTable = bytes.subarray(tableOffset, framesOffset);
    const expectedFrames = bytes.subarray(framesOffset);
    expect(bytes.length).toBe(48 + tableBytes + 10 * 0x40);
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

  it("places the frame-offset table after the audio track tables", async () => {
    const tracks = [
      { maxDecodedSize: 4096, sampleRate: 48_000, flags: 0x3000, trackId: 7 },
      { maxDecodedSize: 2048, sampleRate: 22_050, flags: 0x1000, trackId: 9 },
    ];
    // Revision h has no extra word: 44 + 12 * 2 tracks.
    const bytes = bink2Fixture(3, { revision: "h", tracks });
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      audio_track_count: 2,
      audio_tracks: [
        {
          max_decoded_size: 4096,
          sample_rate: 48_000,
          flags: 0x3000,
          track_id: 7,
        },
        {
          max_decoded_size: 2048,
          sample_rate: 22_050,
          flags: 0x1000,
          track_id: 9,
        },
      ],
      frame_offset_table_offset: 68,
      frame_offset_table_bytes: 16,
      extent_check: "consistent",
    });
    expect(result.contents.get("frame-offsets.bin")).toEqual(
      bytes.subarray(68, 84),
    );
  });

  it("does not place tables for an unknown revision", async () => {
    const result = await read("bink2", bink2Fixture(3, { revision: "z" }));
    expect(result.metadata).toMatchObject({
      revision_char: "z",
      frame_count: 3,
      audio_tracks: null,
      frame_offset_table_offset: null,
      frame_offset_table_bytes: null,
    });
    expect(result.entries).toEqual([]);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(result.coverage[0]?.limitations[0]).toContain(
      "is not a revision FFmpeg's Bink demuxer reads",
    );
  });

  it("does not place tables when reference readers disagree about video flags", async () => {
    const bytes = bink2Fixture(3);
    bytes.writeUInt32LE(0x0000_0004, 36);
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      video_flags: 4,
      frame_offset_table_offset: null,
    });
    expect(result.entries).toEqual([]);
    expect(result.coverage[0]?.limitations[0]).toContain(
      "reference readers disagree",
    );
  });

  it("refuses more audio tracks than Bink demuxers accept", async () => {
    const bytes = bink2Fixture(1);
    bytes.writeUInt32LE(257, 40);
    await expect(read("bink2", bytes)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "bink2", offset: 40 },
    });
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

  it("reports truncated when tables do not fit a matching declared size", async () => {
    // 10 frames need a 44-byte offset table ending at 92; a 64-byte file whose
    // size field matches still cannot hold that table.
    const bytes = bink2Fixture(10).subarray(0, 64);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "bink2",
      extent_check: "truncated",
      frame_offset_table_offset: 48,
      frame_offset_table_bytes: 44,
    });
    expect(result.entries).toEqual([]);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("header tables end at offset"),
      ),
    ).toBe(true);
  });

  it("does not treat bytes past the declared end as audio track facts", async () => {
    // Revision j places tracks at 48; one track needs bytes 48..60. A size field
    // that ends the container at 48 leaves those bytes outside the declaration
    // even when the physical file still holds them.
    const bytes = bink2Fixture(1, {
      revision: "j",
      tracks: [
        {
          maxDecodedSize: 0x1111,
          sampleRate: 48_000,
          flags: 0x3000,
          trackId: 7,
        },
      ],
    });
    bytes.writeUInt32LE(40, 4);
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "bink2",
      audio_track_count: 1,
      audio_tracks: null,
      frame_offset_table_offset: null,
      frame_offset_table_bytes: null,
      declared_size_field: 40,
      extent_check: "trailing-bytes",
    });
    expect(result.entries).toEqual([]);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("audio track tables end at offset"),
      ),
    ).toBe(true);
  });

  it("does not claim trailing bytes beyond the declared end as frames", async () => {
    const base = bink2Fixture(10);
    const tableOffset = 48;
    const tableBytes = 44;
    const framesOffset = tableOffset + tableBytes;
    const trailing = Buffer.alloc(128, 0xee);
    const bytes = Buffer.concat([base, trailing]);
    const result = await read("bink2", bytes);
    expect(result.metadata).toMatchObject({
      kind: "bink2",
      extent_check: "trailing-bytes",
      frame_offset_table_offset: tableOffset,
      frame_offset_table_bytes: tableBytes,
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
        declaredSize: base.length - framesOffset,
      },
    ]);
    expect(result.contents.get("frames.bin")).toEqual(
      base.subarray(framesOffset),
    );
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("follow the last declared"),
      ),
    ).toBe(true);
  });

  it("reports a cut-off Bink 2 header as truncated rather than malformed", async () => {
    const cut = Buffer.from("KB2j\0\0\0\0", "latin1");
    expect(
      recognizeArtifactFormat({ prefix: cut, fileSize: cut.length }),
    ).toMatchObject({ state: "recognized", format: "bink2" });
    await expect(read("bink2", cut)).rejects.toMatchObject({
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

describe("media asset region admission", () => {
  it("refuses an Ogg walk past region_count with a raisable limit", async () => {
    const bytes = oggOpusSpannedTagsFixture();
    await expect(
      read("ogg-opus", bytes, { region_count: 2 }),
    ).rejects.toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.media_asset.region_count",
        effective_value: 2,
        unit: "count",
        update_mode: "parameter",
      },
    });
    const raised = await read("ogg-opus", bytes, { region_count: 4 });
    expect(raised.coverage[0]?.status).toBe("complete");
  });

  it("refuses a RIFF chunk walk past region_count", async () => {
    await expect(
      read("riff-xma2", riffXma2Fixture(), { region_count: 1 }),
    ).rejects.toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.media_asset.region_count",
        effective_value: 1,
      },
    });
  });

  it("counts fixed-layout regions against the same admission", async () => {
    await expect(
      read("vulkan-pipeline-cache", vulkanPipelineCacheFixture(), {
        region_count: 1,
      }),
    ).rejects.toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.media_asset.region_count",
        required_value: 2,
      },
    });
  });
});

describe("incomplete media asset headers", () => {
  it("reports an Ogg Opus file that ends after OpusHead as truncated, not complete", async () => {
    const bytes = oggPage(0, 0n, opusHeadPacket(), 2);
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({ extent_check: "truncated" });
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(
      result.coverage[0]?.limitations.some((line) =>
        line.includes("before the OpusTags packet"),
      ),
    ).toBe(true);
  });

  it.each([
    ["riff-xma2", riffXma2Fixture().subarray(0, 22)],
    ["vulkan-pipeline-cache", vulkanPipelineCacheFixture().subarray(0, 8)],
  ] as const)(
    "recognizes a cut-off %s header and reports it as truncated",
    async (format, cut) => {
      expect(
        recognizeArtifactFormat({ prefix: cut, fileSize: cut.length }),
      ).toMatchObject({ state: "recognized", format });
      await expect(read(format, cut)).rejects.toMatchObject({
        parseFailure: { kind: "truncated", format },
      });
    },
  );
});

describe("Ogg packet boundaries", () => {
  it("does not read OpusHead fields from the next packet on the page", async () => {
    // Lacing [8, 11]: the first packet is only the 8-byte signature; the
    // version, channel and rate bytes belong to a second packet.
    const fields = opusHeadPacket().subarray(8);
    const page = oggPage(
      0,
      0n,
      Buffer.concat([Buffer.from("OpusHead", "latin1"), fields]),
      2,
      { segmentSizes: [8, fields.length] },
    );
    const bytes = Buffer.concat([
      page,
      oggPage(1, 0n, opusTagsPacket(Buffer.from("enc")), 0),
    ]);
    expect(
      recognizeArtifactFormat({ prefix: bytes, fileSize: bytes.length }),
    ).toMatchObject({ state: "recognized", format: "ogg-opus" });
    await expect(read("ogg-opus", bytes)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "ogg-opus", offset: 0 },
    });
  });

  it("does not read the OpusTags vendor from the next packet on the page", async () => {
    // A 12-byte OpusTags packet declares a 4-byte vendor, but the next bytes
    // on its page are a separate packet.
    const short = opusTagsPacket(Buffer.from("enc!")).subarray(0, 12);
    const other = Buffer.from("enc!\0\0\0\0", "latin1");
    const bytes = Buffer.concat([
      oggPage(0, 0n, opusHeadPacket(), 2),
      oggPage(1, 0n, Buffer.concat([short, other]), 0, {
        segmentSizes: [short.length, other.length],
      }),
    ]);
    const result = await read("ogg-opus", bytes);
    expect(result.metadata).toMatchObject({ vendor: null });
    const limitations = result.coverage[0]?.limitations ?? [];
    expect(
      limitations.some((line) => line.includes("only 0 were examined")),
    ).toBe(true);
    expect(
      limitations.some((line) => line.includes("also starts another packet")),
    ).toBe(true);
  });
});
