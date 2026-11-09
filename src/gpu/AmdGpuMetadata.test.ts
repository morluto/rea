import { expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { BinaryResourceFailure } from "../native/metadata/BinaryContainer.js";
import { readAmdMetadata } from "./AmdGpuMetadata.js";
it.each(["\uFEFFkernel", "\uFEFF" + "kernel".repeat(100)])(
  "preserves leading BOMs in MessagePack strings %s",
  (name) => {
    expect(readAmdMetadata(Buffer.from(encode({ name })))).toEqual({ name });
  },
);
it("preserves raw string tags separately from binary values", () => {
  const binary = Uint8Array.from([0x61, 0x62]);
  const read = readAmdMetadata(
    Buffer.from(encode({ text: "ab", binary })),
  ) as Record<string, unknown>;
  expect(read.text).toBe("ab");
  expect(read.binary).toBeInstanceOf(Uint8Array);
  expect(Array.from(read.binary as Uint8Array)).toEqual(Array.from(binary));
});
it("rejects duplicate map keys and malformed UTF-8 before semantic decoding", () => {
  expect(() => readAmdMetadata(Buffer.from("82a16101a16102", "hex"))).toThrow(
    /duplicate/u,
  );
  expect(() => readAmdMetadata(Buffer.from("81a161a1ff", "hex"))).toThrow(
    /UTF-8/u,
  );
});
it("refuses declared container expansion before allocation", () => {
  expect(() => readAmdMetadata(Buffer.from("ddffffffff", "hex"))).toThrow(
    /allocation/u,
  );
});
it("preserves long leading-BOM map keys through the public decoder extension point", () => {
  const key = "\uFEFF" + "field".repeat(60),
    object = { [key]: 123 };
  expect(readAmdMetadata(Buffer.from(encode(object)))).toEqual(object);
});
it("distinguishes an unsupported extension tag from a forbidden MessagePack token", () => {
  expect(() => readAmdMetadata(Buffer.from("d40000", "hex"))).toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  expect(() => readAmdMetadata(Buffer.from("c1", "hex"))).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});
it("refuses a valid array or map past the decoder limit as a capacity failure", () => {
  const array = (length: number) => {
    const header = Buffer.alloc(5);
    header[0] = 0xdd;
    header.writeUInt32BE(length, 1);
    return Buffer.concat([header, Buffer.alloc(length, 0xc0)]);
  };
  expect(readAmdMetadata(array(65536))).toHaveLength(65536);
  expect(() => readAmdMetadata(array(65537))).toThrow(BinaryResourceFailure);
  const map = (pairs: number) => {
    const header = Buffer.alloc(5);
    header[0] = 0xdf;
    header.writeUInt32BE(pairs, 1);
    const entries = Array.from({ length: pairs }, (_, index) => {
      const key = `k${String(index)}`;
      return Buffer.concat([
        Buffer.from([0xa0 | key.length]),
        Buffer.from(key),
        Buffer.from([0xc0]),
      ]);
    });
    return Buffer.concat([header, ...entries]);
  };
  expect(Object.keys(readAmdMetadata(map(65536)) as object)).toHaveLength(
    65536,
  );
  expect(() => readAmdMetadata(map(65537))).toThrow(BinaryResourceFailure);
});
