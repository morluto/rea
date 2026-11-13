import type { FileHandle } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";

import { readMipsElfMetadata } from "./MipsElfMetadata.js";

const payloadOffset = 132;
const source = (
  kind: "abi" | "attributes",
  storage: "plain" | "compressed" | "flagged-plain",
  little: boolean,
) => {
  const payload =
    kind === "abi"
      ? Buffer.from([0, 0, 32, 2, 1, 1, 0, 5, ...Array<number>(16).fill(0)])
      : Buffer.from([
          0x41,
          ...Array<number>(4).fill(0),
          0x67,
          0x6e,
          0x75,
          0,
          1,
          ...Array<number>(4).fill(0),
          4,
          1,
          8,
          0,
        ]);
  const word = (buffer: Buffer, value: number, at: number) =>
    little ? buffer.writeUInt32LE(value, at) : buffer.writeUInt32BE(value, at);
  if (kind === "attributes") {
    word(payload, 17, 1);
    word(payload, 9, 10);
  }
  const compressionHeader = Buffer.alloc(12);
  word(compressionHeader, 1, 0);
  word(compressionHeader, payload.length, 4);
  word(compressionHeader, 4, 8);
  const stored =
    storage === "compressed"
      ? Buffer.concat([compressionHeader, deflateSync(payload)])
      : payload;
  const bytes = Buffer.alloc(payloadOffset + stored.length);
  const half = (value: number, at: number) =>
    little ? bytes.writeUInt16LE(value, at) : bytes.writeUInt16BE(value, at);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, little ? 1 : 2, 1]);
  half(2, 16);
  half(8, 18);
  word(bytes, 1, 20);
  word(bytes, 52, 32);
  word(bytes, 0x70001001, 36);
  half(52, 40);
  half(32, 42);
  half(40, 46);
  half(2, 48);
  word(bytes, kind === "abi" ? 0x7000002a : 0x6ffffff5, 96);
  word(bytes, storage === "plain" ? 0 : 0x800, 100);
  word(bytes, payloadOffset, 108);
  word(bytes, stored.length, 112);
  stored.copy(bytes, payloadOffset);
  return bytes;
};

for (const little of [false, true])
  for (const kind of ["abi", "attributes"] as const)
    it.each(["plain", "compressed", "flagged-plain"] as const)(
      `reads declared ${kind} storage as %s (little=${little})`,
      async (storage) => {
        const bytes = source(kind, storage, little);
        const original = Buffer.from(bytes);
        const reads: number[] = [];
        const handle = {
          stat: async () => ({ size: bytes.length }),
          read: async (
            target: Buffer,
            at: number,
            length: number,
            offset: number,
          ) => {
            reads.push(offset);
            return {
              bytesRead: bytes.copy(target, at, offset, offset + length),
            };
          },
        } as unknown as FileHandle;
        const result = await readMipsElfMetadata(
          handle,
          {
            elfClass: 32,
            byteOrder: little ? "little" : "big",
            type: 2,
            flags: 0x70001001,
          },
          () => {},
        );
        if (storage === "plain") {
          expect(result).toMatchObject({
            ok: true,
            value:
              kind === "abi"
                ? { abiFlags: { version: 0, fpAbi: 5 } }
                : { gnuAttributes: { fpAbi: 1, msa: 0 } },
          });
          expect(reads).toContain(payloadOffset);
        } else {
          expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining(
              `compressed ${kind === "abi" ? "ABI flags" : "GNU attributes"} at file offset ${payloadOffset}`,
            ),
          });
          expect(reads).not.toContain(payloadOffset);
        }
        expect(bytes.equals(original)).toBe(true);
      },
    );

it.each([false, true])(
  "retains unknown shared-load coverage for compressed relocation declarations (%s)",
  async (compressed) => {
    const bytes = Buffer.alloc(4112);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(8, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeUInt32LE(52, 28);
    bytes.writeUInt32LE(128, 32);
    bytes.writeUInt32LE(0x70001001, 36);
    bytes.writeUInt16LE(52, 40);
    bytes.writeUInt16LE(32, 42);
    bytes.writeUInt16LE(2, 44);
    bytes.writeUInt16LE(40, 46);
    bytes.writeUInt16LE(2, 48);
    bytes.writeUInt32LE(1, 52);
    bytes.writeUInt32LE(bytes.length, 68);
    bytes.writeUInt32LE(bytes.length, 72);
    bytes.writeUInt32LE(2, 84);
    bytes.writeUInt32LE(256, 88);
    bytes.writeUInt32LE(256, 92);
    bytes.writeUInt32LE(32, 100);
    bytes.writeUInt32LE(32, 104);
    bytes.writeUInt32LE(9, 172);
    bytes.writeUInt32LE(compressed ? 0x800 : 0, 176);
    bytes.writeUInt32LE(4096, 184);
    bytes.writeUInt32LE(16, 188);
    bytes.writeUInt32LE(8, 204);
    for (const [index, tag, value] of [
      [0, 17, 4096],
      [1, 18, 16],
      [2, 19, 8],
    ] as const) {
      bytes.writeUInt32LE(tag, 256 + index * 8);
      bytes.writeUInt32LE(value, 260 + index * 8);
    }
    const reads: number[] = [];
    const handle = {
      stat: async () => ({ size: bytes.length }),
      read: async (
        target: Buffer,
        at: number,
        length: number,
        offset: number,
      ) => {
        reads.push(offset);
        return { bytesRead: bytes.copy(target, at, offset, offset + length) };
      },
    } as unknown as FileHandle;
    const result = await readMipsElfMetadata(
      handle,
      {
        elfClass: 32,
        byteOrder: "little",
        type: 3,
        flags: 0x70001001,
      },
      () => {},
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        abiFlags: null,
        sharedLoad: compressed
          ? {
              status: "unavailable",
              reason: expect.stringContaining("compressed storage"),
            }
          : { status: "complete", relocationCount: 2, relocationTypes: [0] },
      },
    });
    expect(reads.includes(4096)).toBe(!compressed);
  },
);
