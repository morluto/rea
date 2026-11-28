import { WAVE_FORMAT_XMA2 } from "../../domain/mediaAssetFormats.js";

const fill = (length: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, index) => (index * 131 + 7) & 0xff));

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
};

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

const i16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16LE(value, 0);
  return bytes;
};

const i64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value, 0);
  return bytes;
};

/** Ogg CRC as in RFC 3533 (CRC-32 of the page with the checksum field zeroed). */
const oggCrc = (page: Buffer): number => {
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc =
        (crc & 0x8000_0000) !== 0
          ? ((crc << 1) ^ 0x04c1_1db7) >>> 0
          : (crc << 1) >>> 0;
  }
  return crc >>> 0;
};

export const oggPage = (
  sequence: number,
  granule: bigint,
  data: Buffer,
  flags: number,
  layout: {
    readonly segmentSizes?: readonly number[];
    readonly serial?: number;
  } = {},
): Buffer => {
  const { segmentSizes, serial = 0x1234 } = layout;
  const segments =
    segmentSizes === undefined ? [data.length] : [...segmentSizes];
  if (segments.reduce((sum, size) => sum + size, 0) !== data.length)
    throw new Error("ogg page segment sizes must cover the packet bytes");
  const page = Buffer.concat([
    Buffer.from("OggS", "latin1"),
    Buffer.from([0, flags]),
    i64(granule),
    u32(serial),
    u32(sequence),
    u32(0),
    Buffer.from([segments.length, ...segments]),
    data,
  ]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
};

/** An OpusHead packet: version 1, stereo, pre-skip 312, 48 kHz, gain 0. */
export const opusHeadPacket = (): Buffer =>
  Buffer.concat([
    Buffer.from("OpusHead", "latin1"),
    Buffer.from([1, 2]),
    u16(312),
    u32(48_000),
    i16(0),
    Buffer.from([0]),
  ]);

/** An OpusTags packet with the given vendor bytes and no comments. */
export const opusTagsPacket = (vendor: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from("OpusTags", "latin1"),
    u32(vendor.length),
    vendor,
    u32(0),
  ]);

/** Ogg Opus: OpusHead, OpusTags and one audio page (issue #14155 fixture). */
export const oggOpusFixture = (): Buffer => {
  const head = Buffer.concat([
    Buffer.from("OpusHead", "latin1"),
    Buffer.from([1, 2]),
    u16(312),
    u32(48_000),
    i16(0),
    Buffer.from([0]),
  ]);
  const tags = Buffer.concat([
    Buffer.from("OpusTags", "latin1"),
    u32(4),
    Buffer.from("test", "utf8"),
    u32(0),
  ]);
  return Buffer.concat([
    oggPage(0, 0n, head, 2),
    oggPage(1, 0n, tags, 0),
    oggPage(2, 960n, Buffer.concat([Buffer.from([0xfc]), fill(60)]), 4),
  ]);
};

/**
 * Ogg Opus whose OpusTags packet spans two pages (last lacing value 255 on
 * the first tags page), then one audio page whose payload is a marker.
 */
export const oggOpusSpannedTagsFixture = (): Buffer => {
  const head = Buffer.concat([
    Buffer.from("OpusHead", "latin1"),
    Buffer.from([1, 2]),
    u16(312),
    u32(48_000),
    i16(0),
    Buffer.from([0]),
  ]);
  const vendor = Buffer.alloc(280, 0x41);
  const tags = Buffer.concat([
    Buffer.from("OpusTags", "latin1"),
    u32(vendor.length),
    vendor,
    u32(0),
  ]);
  const firstTags = tags.subarray(0, 255);
  const restTags = tags.subarray(255);
  const audioMarker = Buffer.from([0xab, 0xcd, 0xef]);
  return Buffer.concat([
    oggPage(0, 0n, head, 2),
    oggPage(1, 0n, firstTags, 0, { segmentSizes: [255] }),
    oggPage(2, 0n, restTags, 1),
    oggPage(3, 960n, audioMarker, 4),
  ]);
};

/**
 * OpusTags packet split across many multi-segment pages exceeding the initial
 * header prefix. The layout walk must read pages by position and keep only
 * ranges plus the bounded vendor prefix.
 */
export const oggOpusManyTagsPagesFixture = (tagPages = 48): Buffer => {
  const vendor = Buffer.from("short", "utf8");
  const pagePayload = 16 * 255;
  const tags = Buffer.concat([
    Buffer.from("OpusTags", "latin1"),
    u32(vendor.length),
    vendor,
    u32(0),
    Buffer.alloc(tagPages * pagePayload, 0x5a),
  ]);
  const pages: Buffer[] = [oggPage(0, 0n, opusHeadPacket(), 2)];
  let sequence = 1;
  for (let offset = 0; offset < tags.length;) {
    const take = Math.min(pagePayload, tags.length - offset);
    const segmentSizes: number[] = [];
    for (let remaining = take; remaining > 0;) {
      const seg = Math.min(255, remaining);
      segmentSizes.push(seg);
      remaining -= seg;
    }
    const continued = offset > 0 ? 0x01 : 0;
    pages.push(
      oggPage(sequence, 0n, tags.subarray(offset, offset + take), continued, {
        segmentSizes,
      }),
    );
    sequence += 1;
    offset += take;
  }
  pages.push(oggPage(sequence, 960n, Buffer.from([0xab]), 4));
  return Buffer.concat(pages);
};

/** RIFF WAVE with fmt tag 0x166 (XMA2WAVEFORMATEX, 52-byte fmt). */
export const riffXma2Fixture = (dataBytes = 4096): Buffer => {
  const fmt = Buffer.concat([
    u16(WAVE_FORMAT_XMA2),
    u16(2),
    u32(48_000),
    u32(192_000),
    u16(2048),
    u16(16),
    u16(34),
    u16(1),
    u32(3),
    u32(32_768),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    Buffer.from([4, 1]),
    u16(1),
  ]);
  const body = Buffer.concat([
    Buffer.from("WAVE", "latin1"),
    Buffer.from("fmt ", "latin1"),
    u32(fmt.length),
    fmt,
    Buffer.from("data", "latin1"),
    u32(dataBytes),
    fill(dataBytes),
  ]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32(body.length), body]);
};

/** One declared Bink audio track. */
export interface Bink2FixtureTrack {
  readonly maxDecodedSize: number;
  readonly sampleRate: number;
  readonly flags: number;
  readonly trackId: number;
}

/**
 * Bink 2 header in the layout FFmpeg's demuxer reads (libavformat/bink.c):
 * signature, size - 8, frame count, largest frame size, an unnamed word,
 * width, height, fps numerator and denominator, video flags, audio track
 * count; one extra word for revisions `i`..`k`; per-track max decoded sizes,
 * (sample rate, flags) pairs and IDs; then `frames + 1` frame offsets and
 * opaque frames.
 */
export const bink2Fixture = (
  frames = 10,
  options: {
    readonly revision?: string;
    readonly tracks?: readonly Bink2FixtureTrack[];
  } = {},
): Buffer => {
  const revision = options.revision ?? "j";
  const tracks = options.tracks ?? [];
  const header = Buffer.concat([
    Buffer.from(`KB2${revision}`, "latin1"),
    u32(0),
    u32(frames),
    u32(0x40),
    u32(0),
    u32(1280),
    u32(720),
    u32(30),
    u32(1),
    u32(0x0000_0010),
    u32(tracks.length),
    ...("ijk".includes(revision) ? [u32(0)] : []),
    ...tracks.map((track) => u32(track.maxDecodedSize)),
    ...tracks.map((track) =>
      Buffer.concat([u16(track.sampleRate), u16(track.flags)]),
    ),
    ...tracks.map((track) => u32(track.trackId)),
  ]);
  const table = Buffer.concat(
    Array.from({ length: frames + 1 }, (_, index) => u32(0x100 + index * 0x40)),
  );
  const payload = fill(frames * 0x40);
  const bytes = Buffer.concat([header, table, payload]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
};

/** Vulkan pipeline cache, VK_PIPELINE_CACHE_HEADER_VERSION_ONE. */
export const vulkanPipelineCacheFixture = (opaqueBytes = 2000): Buffer =>
  Buffer.concat([
    u32(32),
    u32(1),
    u32(0x1002),
    u32(0x73bf),
    Buffer.from(Array.from({ length: 16 }, (_, index) => index)),
    fill(opaqueBytes),
  ]);
