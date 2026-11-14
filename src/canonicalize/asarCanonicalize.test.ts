import { describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { CANONICALIZE_SAMPLE_UNITS } from "../domain/canonicalize/canonicalizeArtifact.js";
import type { NormalizerBudget } from "../domain/canonicalize/normalizer.js";
import { canonicalizeAsarBytes, looksLikeAsar } from "./asarCanonicalize.js";

const budget: NormalizerBudget = {
  maxFacts: 128,
  maxDepth: 32,
  sampleUnits: CANONICALIZE_SAMPLE_UNITS,
};

/** Build a Pickle-framed archive directly from raw header bytes. */
const asarArchiveRaw = (
  headerJson: Buffer,
  content: Buffer = Buffer.alloc(0),
): Buffer => {
  const headerBytes = headerJson.length + 8;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBytes, 4);
  prefix.writeUInt32LE(headerBytes - 4, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  return Buffer.concat([prefix, headerJson, content]);
};

describe("canonicalizeAsarBytes header decoding", () => {
  it("rejects an invalid-UTF-8 header via the owning reader's decoder", async () => {
    const header = Buffer.concat([
      Buffer.from('{"files":{"x":"', "utf8"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}}', "utf8"),
    ]);
    const bytes = asarArchiveRaw(header);
    // The framing and leading object token make this look like an ASAR...
    expect(looksLikeAsar(bytes)).toBe(true);
    // ...but the shared strict decoder refuses the invalid bytes rather than
    // replacing them and returning a changed header.
    await expect(canonicalizeAsarBytes(bytes, budget)).rejects.toBeInstanceOf(
      ArtifactReaderFailure,
    );
  });
});
