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
  it("refuses to parse a header beyond this pass's fixed header budget, not a configurable setting", async () => {
    // Declare a header larger than this pass's fixed 16 MiB budget. The pass
    // applies a fixed cutoff, not the configurable asar.max_header_bytes setting
    // the artifact readers honor, and must refuse to decode and duplicate-scan it
    // (the memory-exhaustion vector) before allocating, reporting a truncated
    // result instead.
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
    // The reason is the header budget, so the output must not misattribute the
    // truncation to the reader's listing budget.
    expect(facts.limitations.join(" ")).not.toMatch(/listing budget/iu);
  });
});

describe("canonicalizeAsarBytes reachable retention priority", () => {
  it("retains a reachable entrypoint listed after more than max_facts other files", async () => {
    // A realistic layout: package.json names main.js, but main.js is listed
    // after several unreferenced filler members. Under a small fact budget the
    // fillers would, in listing order, consume every slot and push the proven
    // entrypoint into the overflow digest. The pass must retain reachable
    // entries ahead of unverified ones instead.
    const manifest = Buffer.from(JSON.stringify({ main: "main.js" }), "utf8");
    const files: Record<string, unknown> = {
      "package.json": { size: manifest.length, offset: "0" },
    };
    for (let index = 0; index < 6; index += 1)
      files[`filler${String(index)}.js`] = { size: 1, unpacked: true };
    files["main.js"] = { size: 2, unpacked: true };
    const header = Buffer.from(JSON.stringify({ files }), "utf8");
    const bytes = asarArchiveRaw(header, manifest);

    const facts = await canonicalizeAsarBytes(bytes, {
      ...budget,
      maxFacts: 3,
    });

    const mainFact = facts.core.find((fact) => fact.name === "main.js");
    expect(mainFact?.classification).toBe("behavior-relevant");
    expect(mainFact?.detail).toMatch(/reachable from package\.json/iu);
    // The archive's own manifest is reachable too and must likewise survive.
    expect(
      facts.core.find((fact) => fact.name === "package.json")?.classification,
    ).toBe("behavior-relevant");
    // The unreferenced fillers are what overflowed the fact budget, not main.js.
    expect(
      facts.reductions.some(
        (reduction) => reduction.collection === "asar-entry",
      ),
    ).toBe(true);
  });
});

describe("canonicalizeAsarBytes source facts", () => {
  it("preserves an unpacked member's source facts through the returned facts", async () => {
    // package.json lives packed at offset 0 and names app.js, which is unpacked:
    // its bytes live outside the archive, so its fact must disclose that rather
    // than read identically to a packed member of the same path and size.
    const manifest = Buffer.from(JSON.stringify({ main: "app.js" }), "utf8");
    const header = Buffer.from(
      JSON.stringify({
        files: {
          "package.json": { size: manifest.length, offset: "0" },
          "app.js": { size: 5, unpacked: true },
        },
      }),
      "utf8",
    );
    const bytes = asarArchiveRaw(header, manifest);
    const facts = await canonicalizeAsarBytes(bytes, budget);
    const appFact = facts.core.find((fact) => fact.name === "app.js");
    expect(appFact?.classification).toBe("behavior-relevant");
    expect(appFact?.detail).toMatch(/unpacked/iu);
    expect(appFact?.detail).toMatch(/outside this archive/iu);
  });
});
