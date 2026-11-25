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
    options?: { eos: boolean },
  ): Uint8Array;
};
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
  const dictionary = Buffer.from(valid);
  dictionary.writeUInt32LE(128 * 1024 * 1024, 1);
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
        "oversized dictionary",
        dictionary,
        1024,
        "output-limit",
        "dictionary exceeds the worker memory budget",
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
