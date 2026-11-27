import { expect, it } from "vitest";
import { deflateSync, zstdCompressSync } from "node:zlib";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../domain/analysisResourceLimits.js";
import {
  decodeGpuPayload,
  decodeGpuPayloadStream,
  isTruncatedGpuPayloadFailure,
} from "./GpuPayloadCodec.js";
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

it("stops a many-frame Zstandard payload when the read is cancelled", async () => {
  const frame = zstdByteFrame(0x61);
  const count = 32;
  const bytes = Buffer.alloc(frame.length * count);
  for (let index = 0; index < count; index += 1)
    frame.copy(bytes, index * frame.length);
  const controller = new AbortController();
  const pending = decodeGpuPayload(bytes, "zstd", count, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
});

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
      inputExhausted: false,
    });
    expect(
      await decodeGpuPayloadStream(compressed, codec, source.length),
    ).toEqual({
      buffer: source,
      consumedBytes: compressed.length,
      inputExhausted: codec === "zstd",
    });
    await expect(
      decodeGpuPayloadStream(compressed.subarray(0, -1), codec, source.length),
    ).rejects.toMatchObject({ kind: "malformed" });
    await expect(
      decodeGpuPayload(compressed, codec, source.length + 1),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);

it.each(["zlib", "zstd"] as const)(
  "distinguishes truncated %s streams from corrupt bytes and output overflow",
  async (codec) => {
    const source = Buffer.from("ordinary CCOB marker payload");
    const compressed =
      codec === "zstd" ? zstdCompressSync(source) : deflateSync(source);

    const truncatedError = await decodeGpuPayloadStream(
      compressed.subarray(0, -1),
      codec,
      source.length,
    ).catch((cause: unknown) => cause);
    expect(isTruncatedGpuPayloadFailure(truncatedError)).toBe(true);

    const corruptError = await decodeGpuPayloadStream(
      Buffer.alloc(16, 0xff),
      codec,
      source.length,
    ).catch((cause: unknown) => cause);
    expect(isTruncatedGpuPayloadFailure(corruptError)).toBe(false);

    const overflowError = await decodeGpuPayloadStream(
      compressed,
      codec,
      1,
    ).catch((cause: unknown) => cause);
    expect(isTruncatedGpuPayloadFailure(overflowError)).toBe(false);
  },
);
