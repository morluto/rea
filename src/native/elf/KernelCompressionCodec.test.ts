import { expect, it } from "vitest";
import { kernelCompressionCodecAt } from "./KernelCompressionCodec.js";

const ALL = ["gzip", "bzip2", "lzma", "xz", "lzo", "lz4", "zstd"] as const;

it.each([
  ["gzip", [0x1f, 0x8b]],
  ["bzip2", [0x42, 0x5a, 0x68]],
  ["lzma", [0x5d, 0x00, 0x00]],
  ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ["lzo", [0x89, 0x4c, 0x5a]],
  ["lz4", [0x02, 0x21, 0x4c, 0x18]],
  ["zstd", [0x28, 0xb5, 0x2f, 0xfd]],
] as const)("names a %s stream at an offset", (codec, magic) => {
  const bytes = Buffer.concat([Buffer.from("pad"), Buffer.from(magic)]);
  expect(kernelCompressionCodecAt(bytes, 3, ALL)).toBe(codec);
  expect(kernelCompressionCodecAt(bytes, 0, ALL)).toBeNull();
});

it("names only the accepted codecs and never reads past the bytes", () => {
  const lzma = Buffer.from([0x5d, 0x00, 0x00, 0x80]);
  expect(kernelCompressionCodecAt(lzma, 0, ["gzip", "xz", "zstd"])).toBeNull();
  expect(kernelCompressionCodecAt(lzma, 0, ["lzma"])).toBe("lzma");
  expect(
    kernelCompressionCodecAt(Buffer.from([0xfd, 0x37, 0x7a]), 0, ALL),
  ).toBeNull();
});
