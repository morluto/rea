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

const encodeUnityLzmaWithEndMarker = (data: Buffer): Buffer => {
  const require = createRequire(import.meta.url);
  const lzma = require("lzma-purejs") as {
    compressFile(input: {
      readByte(): number;
      read?(buffer: number[], offset: number, length: number): number;
      eof?(): boolean;
    }): Buffer | Uint8Array;
  };
  let position = 0;
  const alone = Buffer.from(
    lzma.compressFile({
      readByte() {
        return position < data.length ? data[position++]! : -1;
      },
      read(buffer: number[], offset: number, length: number) {
        let count = 0;
        while (count < length && position < data.length)
          buffer[offset + count++] = data[position++]!;
        return count;
      },
      eof() {
        return position >= data.length;
      },
    }),
  );
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

it("accepts a Unity LZMA block that still carries an end marker", async () => {
  const plain = Buffer.from("unityfs lzma end marker bytes ".repeat(8));
  const budget = 64 * 1024 * 1024;
  expect(
    (
      await decodeUnityLzmaBlock(
        encodeUnityLzmaWithEndMarker(plain),
        plain.length,
        budget,
      )
    ).equals(plain),
  ).toBe(true);
});

it("refuses trailing bytes that are not an end marker", async () => {
  const plain = Buffer.from("unityfs lzma trailing");
  const budget = 64 * 1024 * 1024;
  const encoded = Buffer.concat([
    encodeUnityLzma(plain),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
  ]);
  await expect(
    decodeUnityLzmaBlock(encoded, plain.length, budget),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a truncated Unity LZMA header", async () => {
  await expect(
    decodeUnityLzmaBlock(Buffer.from([0x5d, 0, 0]), 4, 4),
  ).rejects.toMatchObject({
    kind: "malformed",
  });
});

it("refuses Unity LZMA properties outside the decoder range", async () => {
  await expect(
    decodeUnityLzmaBlock(
      Buffer.from([0xff, 0, 0, 0x80, 0, 0, 1, 2, 3, 4]),
      1,
      1,
    ),
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

it("preserves timer-driven cancellation during Unity LZMA decode", async () => {
  const plain = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const budget = 64 * 1024 * 1024;
  const encoded = encodeUnityLzma(plain);
  const controller = new AbortController();
  const reason = new Error("cancel during lzma decode");
  const pending = decodeUnityLzmaBlock(
    encoded,
    plain.length,
    budget,
    controller.signal,
  );
  globalThis.setImmediate(() => {
    controller.abort(reason);
  });
  await expect(pending).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});
