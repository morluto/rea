import { describe, expect, it } from "vitest";

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
  it("rejects invalid UTF-8 in an otherwise valid header, by UTF-8 failure", async () => {
    // The invalid byte sits inside an otherwise valid filename and a
    // structurally valid header. A lossy decoder would turn it into U+FFFD and
    // succeed, so only strict decoding rejects it — the assertion pins that.
    const header = Buffer.concat([
      Buffer.from('{"files":{"a', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('b":{"size":1,"offset":"0"}}}', "utf8"),
    ]);
    const bytes = asarArchiveRaw(header);
    expect(looksLikeAsar(bytes)).toBe(true);
    await expect(canonicalizeAsarBytes(bytes, budget)).rejects.toThrow(
      /not valid UTF-8/iu,
    );
  });
});

describe("canonicalizeAsarBytes header admission", () => {
  it("refuses to parse a header beyond asar.max_header_bytes, returning a bounded partial", async () => {
    // Declare a header larger than REA's documented 16 MiB admission. The pass
    // must refuse to decode and duplicate-scan it (the memory-exhaustion vector)
    // before allocating, and report an explicit truncated result instead.
    const headerJson = Buffer.alloc(16 * 1024 * 1024 + 64, 0x20);
    headerJson[0] = 0x7b; // '{' so the framing is recognized as an ASAR
    const bytes = asarArchiveRaw(headerJson);
    expect(looksLikeAsar(bytes)).toBe(true);
    const facts = await canonicalizeAsarBytes(bytes, budget);
    expect(facts.core).toHaveLength(0);
    expect(facts.coverage.status).toBe("partial");
    expect(facts.coverage.truncated).toBe(true);
    expect(facts.limitations[0]).toMatch(/fixed .*header budget/iu);
    expect(facts.limitations[0]).toMatch(/unverified/iu);
  });
});
