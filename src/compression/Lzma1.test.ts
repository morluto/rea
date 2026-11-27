import { describe, expect, it } from "vitest";
import {
  decodeLzma1Alone,
  lzma1AloneHeader,
  type Lzma1Codec,
} from "./Lzma1.js";

/** A 13-byte LZMA-Alone header (lc=3 lp=0 pb=2) plus a zero lead-in. */
const alone = (): Buffer => {
  const bytes = Buffer.alloc(18);
  bytes[0] = 0x5d;
  bytes.writeUInt32LE(1 << 16, 1);
  bytes.writeBigUInt64LE(4n, 5);
  return bytes;
};

const codecThrowing = (cause: unknown): Lzma1Codec => ({
  decompressFile() {
    throw cause;
  },
});

const decode = (codec: Lzma1Codec) =>
  decodeLzma1Alone(codec, alone(), lzma1AloneHeader(1 << 16, 4n), {
    outputLimit: 16,
  });

describe("LZMA1 verdicts versus host faults", () => {
  it.each(["Error in data stream", "Incorrect stream properties"])(
    "reports the codec's own verdict %j as malformed",
    (verdict) => {
      expect(decode(codecThrowing(verdict))).toEqual({
        ok: false,
        kind: "malformed",
        message: `${verdict}.`,
      });
    },
  );

  it.each([
    new RangeError("Array buffer allocation failed"),
    new TypeError("codec defect"),
    "an unrecognized string",
  ])(
    "leaves a host fault (%s) to its host instead of calling it malformed",
    (fault) => {
      expect(() => decode(codecThrowing(fault))).toThrow(
        fault instanceof Error ? fault : undefined,
      );
    },
  );
});
