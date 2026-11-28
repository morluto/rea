import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../../src/resources/index.js";
import { UefiLzmaSession } from "../../../src/uefi/UefiLzmaSession.js";
import type { UefiDecodeResult } from "../../../src/uefi/UefiScanContext.js";

const { compressFile } = createRequire(import.meta.url)("lzma-purejs") as {
  compressFile(
    bytes: Buffer,
    output?: undefined,
    options?: {
      readonly eos?: boolean;
      readonly lc?: number;
      readonly lp?: number;
      readonly pb?: number;
    },
  ): Uint8Array;
};

/**
 * An EFI_LZMA_CUSTOM_DECOMPRESS stream from an independent encoder, liblzma
 * (CPython 3.14 `lzma`, FORMAT_ALONE, lc=3 lp=0 pb=2, 8 MiB dictionary).
 * liblzma writes an unknown size and an end marker.
 */
const LIBLZMA_ALONE = Buffer.from(
  "5d00008000ffffffffffffffff0022910593f2a4283ff5c5369524668fa2489934894d7be376f4b5c9a9df635eac35da2b9d0e5814bf13159f5fc05e856ba3a24078083542bbeff03782781f989cc07e2a0820c2b13429eafee0048c4896ffff064e0000",
  "hex",
);
const LIBLZMA_PLAIN = Buffer.concat([
  Buffer.from("EDK II LZMA custom section known answer ".repeat(16)),
  Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
]);
const workerPath = fileURLToPath(
  new URL("../../../dist/uefi/UefiLzmaWorker.js", import.meta.url),
);

type Decode = (bytes: Buffer, limit: number) => Promise<UefiDecodeResult>;

async function withDecoder(
  probe: (decode: Decode) => Promise<void>,
): Promise<void> {
  const resources = new ArtifactResourceScope();
  const session = new UefiLzmaSession(
    workerPath,
    "inspect_uefi_firmware",
    resources,
  );
  onTestFinished(() => resources.close());
  const signal = AbortSignal.timeout(30_000);
  try {
    await resources.run(() =>
      probe((bytes, limit) => session.decode(bytes, "lzma", limit, signal)),
    );
  } finally {
    await session.close();
  }
}

function expectDecoded(
  result: UefiDecodeResult,
  expected: Buffer,
  consumed: number,
): void {
  if (!result.ok) throw new Error(result.message);
  expect(result.outcome.decoderVersion).toBe("0.9.3");
  expect(result.outcome.consumedBytes).toBe(consumed);
  expect(result.outcome.bytes.equals(expected)).toBe(true);
}

it("decodes real compressed bytes through stdio and accepts the minimum effective dictionary", async () => {
  const plain = Buffer.from(
    "Static firmware bytes for the dictionary fixture. ".repeat(50),
  );
  const normal = Buffer.from(compressFile(plain));
  const small = Buffer.from(normal);
  small.writeUInt32LE(16, 1);
  await withDecoder(async (decode) => {
    expectDecoded(await decode(normal, plain.length), plain, normal.length);
    expectDecoded(await decode(small, plain.length), plain, small.length);
  });
});

it("returns typed limit and framing refusals through stdio without losing the next reply", async () => {
  const plain = Buffer.from(
    "Static firmware data for the LZMA worker's read boundary.".repeat(5),
  );
  const valid = Buffer.from(compressFile(plain));
  const wrongLeadIn = Buffer.from(valid);
  wrongLeadIn[13] = 1;
  const unknownSize = Buffer.from(
    compressFile(plain, undefined, { eos: true }),
  );
  unknownSize.writeBigUInt64LE(0xffffffffffffffffn, 5);
  await withDecoder(async (decode) => {
    for (const [label, input, limit, reason, message] of [
      [
        "short header",
        valid.subarray(0, 9),
        1024,
        "malformed",
        "Incomplete LZMA stream header",
      ],
      [
        "short coded body",
        valid.subarray(0, -1),
        1024,
        "malformed",
        "Compressed stream ends before the decoder can finish",
      ],
      [
        "initial range coder byte",
        wrongLeadIn,
        1024,
        "malformed",
        "range coder byte must be zero",
      ],
      [
        "declared output budget",
        valid,
        16,
        "output-limit",
        "Declared LZMA output exceeds 16 bytes",
      ],
      [
        "streamed output budget",
        unknownSize,
        16,
        "output-limit",
        "Decompressed output exceeds the 16 byte budget",
      ],
    ] as const) {
      expect(await decode(input, limit), label).toEqual({
        ok: false,
        reason,
        message: expect.stringContaining(message),
      });
    }
    expectDecoded(await decode(valid, plain.length), plain, valid.length);
  });
});

it("accounts for optional and required end markers in the reported consumed span", async () => {
  const plain = Buffer.from("UEFI audit fixture");
  const markerless = compressFile(plain);
  const withMarker = Buffer.from(compressFile(plain, undefined, { eos: true }));
  expect(withMarker.length).toBeGreaterThan(markerless.length);
  const unknownSize = Buffer.from(withMarker);
  unknownSize.writeBigUInt64LE(0xffffffffffffffffn, 5);
  const trailing = Buffer.from("unread fixture bytes");
  await withDecoder(async (decode) => {
    for (const [input, consumed] of [
      [withMarker, markerless.length],
      [unknownSize, withMarker.length],
    ] as const) {
      expectDecoded(
        await decode(Buffer.concat([input, trailing]), 1024),
        plain,
        consumed,
      );
    }
  });
});

it("sizes the decoder from the output, not the dictionary, and decodes an independent encoder's stream", async () => {
  const plain = Buffer.from("tiny raw payload in an LZMA section");
  const valid = Buffer.from(compressFile(plain));
  // EDK II's one-call LzmaDecode uses its output buffer as the dictionary, so
  // the declared dictionary never bounds a valid stream.
  const large = Buffer.from(valid);
  large.writeUInt32LE(32 * 1024 * 1024, 1);
  const overLimit = Buffer.from(valid);
  overLimit.writeUInt32LE(0x7000_0000, 1);
  await withDecoder(async (decode) => {
    expectDecoded(await decode(large, plain.length), plain, large.length);
    expectDecoded(
      await decode(overLimit, plain.length),
      plain,
      overLimit.length,
    );
    expectDecoded(
      await decode(LIBLZMA_ALONE, LIBLZMA_PLAIN.length),
      LIBLZMA_PLAIN,
      LIBLZMA_ALONE.length,
    );
  });
});

it("applies the LZMA1 property bounds and reports a corrupt stream as malformed", async () => {
  const plain = Buffer.from(
    "LZMA1 property bounds on a UEFI section ".repeat(6),
  );
  const wide = Buffer.from(
    compressFile(plain, undefined, { lc: 4, lp: 1, pb: 2 }),
  );
  const outOfRange = Buffer.from(compressFile(plain));
  outOfRange[0] = 225;
  const corrupt = Buffer.from(compressFile(plain));
  for (let index = 20; index < corrupt.length; index += 3)
    corrupt[index]! ^= 0x5a;
  await withDecoder(async (decode) => {
    // lc + lp <= 4 is an LZMA2 rule; LZMA1 admits lc 0-8, lp 0-4, pb 0-4.
    expectDecoded(await decode(wide, plain.length), plain, wide.length);
    expect(await decode(outOfRange, plain.length)).toEqual({
      ok: false,
      reason: "malformed",
      message: expect.stringContaining("LZMA properties are outside"),
    });
    // A decoder verdict about the bytes, not a worker fault.
    expect(await decode(corrupt, plain.length)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});
