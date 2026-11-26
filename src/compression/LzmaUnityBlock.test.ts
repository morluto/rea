import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { decodeUnityLzmaBlock } from "./LzmaUnityBlock.js";

const encodeUnityLzma = (data: Buffer): Buffer => {
  const require = createRequire(import.meta.url);
  const lzma = require("lzma-purejs") as {
    compressFile(input: Buffer): Buffer | Uint8Array;
  };
  const alone = Buffer.from(lzma.compressFile(data));
  return Buffer.concat([alone.subarray(0, 5), alone.subarray(13)]);
};

it("decodes a Unity LZMA block to its declared size", async () => {
  const plain = Buffer.from("unityfs lzma member bytes ".repeat(8));
  const budget = 64 * 1024 * 1024;
  expect(
    (
      await decodeUnityLzmaBlock(encodeUnityLzma(plain), plain.length, budget)
    ).equals(plain),
  ).toBe(true);
});

it("refuses a truncated Unity LZMA header", async () => {
  await expect(decodeUnityLzmaBlock(Buffer.from([0x5d, 0, 0]), 4, 4)).rejects.toMatchObject({
    kind: "malformed",
  });
});

it("refuses Unity LZMA properties outside the decoder range", async () => {
  await expect(
    decodeUnityLzmaBlock(Buffer.from([0xff, 0, 0, 0x80, 0, 0, 1, 2, 3, 4]), 1, 1),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a Unity LZMA stream that cannot finish", async () => {
  await expect(
    decodeUnityLzmaBlock(Buffer.from([0x5d, 0, 0, 0, 1, 0, 0xff, 0xff]), 8, 8),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a decode whose declared length exceeds the budget", async () => {
  await expect(
    decodeUnityLzmaBlock(encodeUnityLzma(Buffer.from("x")), 2, 1),
  ).rejects.toMatchObject({ kind: "limit" });
});
