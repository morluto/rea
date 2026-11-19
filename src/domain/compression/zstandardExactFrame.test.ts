import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
  DEFAULT_ZSTD_MAX_FRAMES,
} from "../analysisResourceLimits.js";
import { ConfigurationError } from "../configurationErrors.js";
import {
  decodeZstandardFrames,
  ownedZstandardBytes,
} from "./zstandardExactFrame.js";
import {
  resolveZstandardFrameAllowance,
  ZSTD_MAX_FRAMES_ENVIRONMENT,
  ZSTD_MAX_FRAMES_SETTING,
} from "./zstandardFrameAllowance.js";

const rawFrame = (byte: number): Buffer =>
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, byte]);

const repeat = (frame: Buffer, count: number): Buffer => {
  const bytes = Buffer.alloc(frame.length * count);
  for (let index = 0; index < count; index += 1)
    frame.copy(bytes, index * frame.length);
  return bytes;
};

const skippable = (payload: Buffer, magic = 0x184d2a50): Buffer => {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32LE(magic, 0);
  bytes.writeUInt32LE(payload.length, 4);
  payload.copy(bytes, 8);
  return bytes;
};

const allowance = (
  maxFrames: number,
  source: "default" | "setting" | "runtime",
) => ({ maxFrames, source });

describe("exact Zstandard frames", () => {
  it("accepts concatenated frames and skippable frames", () => {
    const first = rawFrame(0x61);
    const second = rawFrame(0x62);
    const skip = skippable(Buffer.from("skip"), 0x184d2a5f);
    const bytes = Buffer.concat([
      skip,
      first,
      skippable(Buffer.alloc(0)),
      second,
    ]);
    const decoded = decodeZstandardFrames(bytes, {
      allowance: allowance(8, "default"),
    });
    expect(decoded).toMatchObject({
      ok: true,
      consumedBytes: bytes.length,
      frames: 4,
    });
    if (!decoded.ok) return;
    expect([...decoded.bytes]).toEqual([0x61, 0x62]);
  });

  it.each([
    [
      "frame header",
      (frame: Buffer) => frame.subarray(0, 5),
      "truncated_frame_header",
    ],
    ["block", (frame: Buffer) => frame.subarray(0, -1), "truncated_block"],
  ] as const)("rejects a truncated %s", (_label, trim, reason) => {
    expect(decodeZstandardFrames(trim(rawFrame(0x61)))).toMatchObject({
      ok: false,
      reason,
      offset: expect.any(Number),
    });
  });

  it("rejects a truncated checksum and a wrong checksum separately", () => {
    const frame = zstdCompressSync(Buffer.from("hello zstd checksum"), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    });
    expect(decodeZstandardFrames(frame.subarray(0, -1))).toMatchObject({
      ok: false,
      reason: "truncated_checksum",
    });
    expect(decodeZstandardFrames(frame.subarray(0, -4))).toMatchObject({
      ok: false,
      reason: "truncated_checksum",
    });
    const wrong = Buffer.from(frame);
    const last = wrong.length - 1;
    wrong.writeUInt8(wrong.readUInt8(last) ^ 0xff, last);
    expect(decodeZstandardFrames(wrong)).toMatchObject({
      ok: false,
      reason: "malformed",
      code: "ZSTD_error_checksum_wrong",
    });
    expect(decodeZstandardFrames(frame)).toMatchObject({ ok: true });
  });

  it("rejects trailing garbage and a partial next-frame magic", () => {
    const frame = rawFrame(0x61);
    expect(
      decodeZstandardFrames(Buffer.concat([frame, Buffer.of(0)])),
    ).toMatchObject({ ok: false, reason: "trailing_bytes" });
    expect(
      decodeZstandardFrames(
        Buffer.concat([frame, Buffer.of(0x28, 0xb5, 0x2f)]),
      ),
    ).toMatchObject({ ok: false, reason: "trailing_bytes" });
    expect(
      decodeZstandardFrames(
        Buffer.concat([frame, Buffer.of(0x28, 0xb5, 0x2f, 0xfd)]),
      ),
    ).toMatchObject({ ok: false, reason: "truncated_frame_header" });
  });

  it("stops a prefix at the first non-frame byte", () => {
    const frame = rawFrame(0x61);
    const suffix = Buffer.from("CCOB");
    const decoded = decodeZstandardFrames(Buffer.concat([frame, suffix]), {
      mode: "prefix",
    });
    expect(decoded).toMatchObject({
      ok: true,
      consumedBytes: frame.length,
      frames: 1,
    });
  });

  it("refuses 65536 productive frames on the work allowance", () => {
    const count = 65_536;
    const frame = rawFrame(0x61);
    const bytes = repeat(frame, count);
    expect(
      decodeZstandardFrames(bytes, {
        maxOutputLength: count,
        allowance: allowance(count - 1, "setting"),
      }),
    ).toMatchObject({
      ok: false,
      reason: "work_limit",
      setting: ZSTD_MAX_FRAMES_SETTING,
      value: count - 1,
      source: "setting",
      minimum: MINIMUM_ZSTD_MAX_FRAMES,
      maximum: MAXIMUM_ZSTD_MAX_FRAMES,
    });
    const decoded = decodeZstandardFrames(bytes, {
      maxOutputLength: count,
      allowance: allowance(count, "runtime"),
    });
    expect(decoded).toMatchObject({
      ok: true,
      frames: count,
      consumedBytes: bytes.length,
    });
    if (!decoded.ok) return;
    expect(decoded.bytes.length).toBe(count);
    expect(decoded.bytes[0]).toBe(0x61);
    expect(decoded.bytes[count - 1]).toBe(0x61);
  });
});

it("does not retain a decoder chunk behind a short frame", () => {
  const backing = Buffer.alloc(16 * 1024, 0x61);
  const slice = backing.subarray(0, 1);
  const owned = ownedZstandardBytes(slice);
  expect(owned.length).toBe(1);
  expect(owned[0]).toBe(0x61);
  expect(owned.buffer).not.toBe(backing.buffer);
  const exact = Buffer.allocUnsafeSlow(1);
  exact[0] = 0x62;
  expect(ownedZstandardBytes(exact)).toBe(exact);
});

describe("zstd.max_frames allowance", () => {
  it("resolves default, launch, and runtime sources", () => {
    expect(resolveZstandardFrameAllowance({})).toEqual({
      maxFrames: DEFAULT_ZSTD_MAX_FRAMES,
      source: "default",
    });
    expect(
      resolveZstandardFrameAllowance({ [ZSTD_MAX_FRAMES_ENVIRONMENT]: "8" }),
    ).toEqual({ maxFrames: 8, source: "setting" });
    expect(resolveZstandardFrameAllowance({}, 3)).toEqual({
      maxFrames: 3,
      source: "runtime",
    });
    expect(() =>
      resolveZstandardFrameAllowance({ [ZSTD_MAX_FRAMES_ENVIRONMENT]: "0" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      resolveZstandardFrameAllowance({
        [ZSTD_MAX_FRAMES_ENVIRONMENT]: String(MAXIMUM_ZSTD_MAX_FRAMES + 1),
      }),
    ).toThrow(ConfigurationError);
  });
});
