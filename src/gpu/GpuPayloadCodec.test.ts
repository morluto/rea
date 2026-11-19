import { expect, it } from "vitest";
import { deflateSync, zstdCompressSync } from "node:zlib";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../domain/analysisResourceLimits.js";
import { decodeGpuPayload, decodeGpuPayloadStream } from "./GpuPayloadCodec.js";
it.each(["zlib", "zstd"] as const)(
  "requires all declared %s input bytes to belong to the codec stream",
  async (codec) => {
    const source = Buffer.from("kernel"),
      encode = codec === "zstd" ? zstdCompressSync : deflateSync,
      compressed = encode(source);
    expect(
      Buffer.compare(
        await decodeGpuPayload(compressed, codec, source.length),
        source,
      ),
    ).toBe(0);
    await expect(
      decodeGpuPayload(
        Buffer.concat([compressed, Buffer.from("junk")]),
        codec,
        source.length,
      ),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);
const zstdByteFrame = (byte: number): Buffer =>
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, byte]);

it("decodes every Zstandard frame before a container suffix", async () => {
  const frames = Buffer.concat([zstdByteFrame(0x61), zstdByteFrame(0x62)]);
  const plain = Buffer.from([0x61, 0x62]);
  expect(Buffer.compare(await decodeGpuPayload(frames, "zstd", 2), plain)).toBe(
    0,
  );
  const streamed = await decodeGpuPayloadStream(
    Buffer.concat([frames, Buffer.from("CCOB")]),
    "zstd",
    2,
  );
  expect(Buffer.compare(streamed.buffer, plain)).toBe(0);
  expect(streamed.consumedBytes).toBe(frames.length);
  await expect(
    runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "zstd.max_frames": 1 } },
      () => decodeGpuPayload(frames, "zstd", 2),
    ),
  ).rejects.toMatchObject({
    reason: "work_limit",
    setting: "zstd.max_frames",
    value: 1,
    source: "runtime",
    minimum: MINIMUM_ZSTD_MAX_FRAMES,
    maximum: MAXIMUM_ZSTD_MAX_FRAMES,
  });
});

it.each(["zlib", "zstd"] as const)(
  "retains completed %s input accounting before trailing container bytes",
  async (codec) => {
    const source = Buffer.from("ordinary CCOB marker"),
      compressed =
        codec === "zstd"
          ? zstdCompressSync(source)
          : deflateSync(source, { level: 0 }),
      input = Buffer.concat([
        compressed,
        Buffer.from("CCOB following container"),
      ]);
    expect(await decodeGpuPayloadStream(input, codec, source.length)).toEqual({
      buffer: source,
      consumedBytes: compressed.length,
    });
    await expect(
      decodeGpuPayloadStream(compressed.subarray(0, -1), codec, source.length),
    ).rejects.toMatchObject({ kind: "malformed" });
    await expect(
      decodeGpuPayload(compressed, codec, source.length + 1),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);
