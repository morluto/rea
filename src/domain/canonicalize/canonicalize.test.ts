import { describe, expect, it } from "vitest";

import { canonicalizeArtifactFacts } from "./engine.js";
import {
  CANONICALIZE_SAMPLE_UNITS,
  type CanonicalizeFact,
} from "./canonicalizeArtifact.js";
import type { NormalizerBudget } from "./normalizer.js";

const budget = (
  overrides: Partial<NormalizerBudget> = {},
): NormalizerBudget => ({
  maxFacts: 128,
  maxDepth: 32,
  sampleUnits: CANONICALIZE_SAMPLE_UNITS,
  ...overrides,
});

// --- WASM fixture helpers -------------------------------------------------

const lebU32 = (value: number): Buffer => {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return Buffer.from(out);
};

const wasmSection = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([id]), lebU32(payload.length), payload]);

const wasmCustomSection = (name: string, content: Buffer): Buffer => {
  const nameBytes = Buffer.from(name, "utf8");
  return wasmSection(
    0,
    Buffer.concat([lebU32(nameBytes.length), nameBytes, content]),
  );
};

const wasmModule = (sections: readonly Buffer[]): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    ...sections,
  ]);

const named = (facts: readonly CanonicalizeFact[], name: string) =>
  facts.find((fact) => fact.name === name);

// --- WASM -----------------------------------------------------------------

describe("wasm-sections normalizer", () => {
  const typePayload = Buffer.from([0x01, 0x60, 0x00, 0x00]);
  const decoy = Buffer.alloc(4096, 0x41);
  const bytes = wasmModule([
    wasmSection(1, typePayload),
    wasmCustomSection("name", Buffer.alloc(2048, 0x42)),
    wasmCustomSection("bla.enclave.manifest", decoy),
    wasmCustomSection("linking", Buffer.from([0x02, 0x00])),
  ]);

  it("recognizes WASM and classifies sections by behavior relevance", () => {
    const facts = canonicalizeArtifactFacts(bytes, "auto", budget());
    expect(facts.detected_format).toBe("wasm");
    expect(facts.normalizer).toBe("wasm-sections");
    expect(named(facts.core, "type")?.classification).toBe("behavior-relevant");
    // Link-relevant custom sections are retained as behavior-relevant.
    expect(named(facts.core, "linking")?.classification).toBe(
      "behavior-relevant",
    );
    // Non-link custom sections (debug name, injected decoy) are collapsed.
    expect(named(facts.collapsed, "name")?.classification).toBe(
      "non-semantic-padding",
    );
    const injected = named(facts.collapsed, "bla.enclave.manifest");
    expect(injected?.classification).toBe("non-semantic-padding");
    // The region spans the whole custom-section payload (name plus content).
    expect(injected?.bytes).toBeGreaterThanOrEqual(decoy.length);
    expect(injected?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(facts.coverage).toMatchObject({
      status: "complete",
      truncated: false,
    });
  });

  it("is lossless for behavior-relevant regions: core ranges reproduce the bytes", () => {
    const facts = canonicalizeArtifactFacts(bytes, "auto", budget());
    const type = named(facts.core, "type");
    expect(type?.location).not.toBeNull();
    const slice = bytes.subarray(
      type!.location!.offset,
      type!.location!.offset + type!.location!.bytes,
    );
    expect(Buffer.compare(slice, typePayload)).toBe(0);
    expect(type!.bytes).toBe(typePayload.length);
  });

  it("collapses custom sections beyond the exemplar budget to counts and a group digest", () => {
    const many = wasmModule([
      wasmSection(1, typePayload),
      ...Array.from({ length: 10 }, (_unused, index) =>
        wasmCustomSection(`decoy.${String(index)}`, Buffer.alloc(16, 0x43)),
      ),
    ]);
    const facts = canonicalizeArtifactFacts(
      many,
      "wasm",
      budget({ maxFacts: 3 }),
    );
    const reduction = facts.reductions.find(
      (entry) => entry.collection === "wasm-custom-section",
    );
    expect(reduction).toMatchObject({
      examined: 10,
      retained: 3,
      collapsed: 7,
    });
    // Items beyond the budget keep a bounded group identity (finding 11).
    expect(reduction?.group_sha256).toMatch(/^[a-f0-9]{64}$/u);
    // Omitting sections reports partial coverage, not false completeness.
    expect(facts.coverage.status).toBe("partial");
  });

  it("caps link-relevant reloc sections and keeps a group digest", () => {
    const relocs = Array.from({ length: 5 }, (_unused, index) =>
      wasmCustomSection(`reloc.CODE${String(index)}`, Buffer.from([0x00])),
    );
    const facts = canonicalizeArtifactFacts(
      wasmModule([wasmSection(1, typePayload), ...relocs]),
      "wasm",
      budget({ maxFacts: 2 }),
    );
    const retainedLink = facts.core.filter(
      (fact) =>
        fact.collection === "wasm-custom-section" &&
        fact.classification === "behavior-relevant",
    );
    expect(retainedLink).toHaveLength(2);
    const reduction = facts.reductions.find(
      (entry) => entry.collection === "wasm-link-section",
    );
    expect(reduction).toMatchObject({ examined: 5, retained: 2, collapsed: 3 });
    expect(reduction?.group_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("bounds an inflated custom-section name in the retained fact", () => {
    const longName = "a".repeat(300);
    const facts = canonicalizeArtifactFacts(
      wasmModule([
        wasmSection(1, typePayload),
        wasmCustomSection(longName, Buffer.alloc(8, 0x42)),
      ]),
      "wasm",
      budget(),
    );
    const custom = facts.collapsed.find(
      (fact) => fact.collection === "wasm-custom-section",
    );
    expect(custom).toBeDefined();
    expect((custom?.name ?? "").length).toBeLessThanOrEqual(128);
    expect(custom?.detail).toMatch(/truncated/u);
  });

  it("does not miscount a retained link section as collapsed", () => {
    const facts = canonicalizeArtifactFacts(
      wasmModule([
        wasmSection(1, typePayload),
        wasmCustomSection("linking", Buffer.from([0x02, 0x00])),
      ]),
      "wasm",
      budget(),
    );
    expect(named(facts.core, "linking")?.classification).toBe(
      "behavior-relevant",
    );
    // A retained section must not appear as a further "collapsed" reduction.
    expect(facts.reductions).toHaveLength(0);
    expect(facts.coverage.status).toBe("complete");
  });

  it("stays defensive on a truncated section header", () => {
    const truncated = Buffer.concat([
      wasmModule([wasmSection(1, typePayload)]),
      Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x0f]),
    ]);
    const facts = canonicalizeArtifactFacts(truncated, "wasm", budget());
    expect(facts.coverage.truncated).toBe(true);
    expect(facts.coverage.status).toBe("partial");
    expect(facts.limitations.join(" ")).toMatch(/truncated|malformed/iu);
  });
});

// --- JSON -----------------------------------------------------------------

describe("json-structure normalizer", () => {
  it("retains behavior-relevant scalar content as bounded facts", () => {
    const facts = canonicalizeArtifactFacts(
      Buffer.from(
        JSON.stringify({ main: "index.js", version: "1.0.0" }),
        "utf8",
      ),
      "auto",
      budget(),
    );
    expect(facts.detected_format).toBe("json");
    expect(facts.core[0]).toMatchObject({ collection: "json-root" });
    const main = facts.core.find((fact) => fact.name === "$/main");
    expect(main?.classification).toBe("behavior-relevant");
    expect(main?.sample).toBe("index.js");
    expect(facts.coverage.status).toBe("complete");
  });

  it("collapses nesting beyond max_depth and marks it truncated and unverified", () => {
    let nested = "0";
    for (let depth = 0; depth < 40; depth += 1) nested = `[${nested}]`;
    const facts = canonicalizeArtifactFacts(
      Buffer.from(nested, "utf8"),
      "auto",
      budget({ maxDepth: 8 }),
    );
    expect(facts.detected_format).toBe("json");
    expect(facts.coverage.truncated).toBe(true);
    expect(facts.coverage.status).toBe("partial");
    expect(
      facts.reductions.some((entry) => entry.collection === "json-depth"),
    ).toBe(true);
    // Depth-collapsed structure is unverified, never asserted as padding.
    expect(
      facts.collapsed.every((fact) => fact.classification === "unverified"),
    ).toBe(true);
  });

  it("marks budget-skipped children unverified with partial coverage, never padding", () => {
    const wide = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 500 }, (_unused, index) => [
          `k${String(index)}`,
          index,
        ]),
      ),
    );
    const facts = canonicalizeArtifactFacts(
      Buffer.from(wide, "utf8"),
      "json",
      budget({ maxFacts: 16 }),
    );
    const reduction = facts.reductions.find(
      (entry) => entry.collection === "json-children",
    );
    // Root fact plus 15 retained children leaves 485 of 500 unvisited.
    expect(reduction?.collapsed).toBe(485);
    expect(facts.coverage.status).toBe("partial");
    expect(facts.coverage.truncated).toBe(true);
    expect(facts.core[0]).toMatchObject({ collection: "json-root" });
    expect(
      facts.collapsed.every((fact) => fact.classification === "unverified"),
    ).toBe(true);
    expect(
      [...facts.core, ...facts.collapsed].some(
        (fact) => fact.classification === "non-semantic-padding",
      ),
    ).toBe(false);
  });

  it("bounds an inflated key in the fact name and keeps a digest reference", () => {
    const hugeKey = "k".repeat(4000);
    const facts = canonicalizeArtifactFacts(
      Buffer.from(JSON.stringify({ [hugeKey]: 1 }), "utf8"),
      "json",
      budget(),
    );
    const leaf = facts.core.find((fact) => fact.collection === "json-value");
    expect(leaf).toBeDefined();
    // The 4000-unit key cannot be reproduced verbatim in the fact name.
    expect((leaf?.name ?? "").length).toBeLessThanOrEqual(256);
    // The exact key is preserved by reference, not confabulated away.
    expect(leaf?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("escapes slashes in keys so distinct members get distinct names", () => {
    const facts = canonicalizeArtifactFacts(
      Buffer.from(JSON.stringify({ "a/b": 1, a: { b: 2 } }), "utf8"),
      "json",
      budget(),
    );
    const names = facts.core.map((fact) => fact.name);
    // The key "a/b" becomes "$/a~1b"; the nested a.b becomes "$/a/b" — distinct.
    expect(names).toContain("$/a~1b");
    expect(names).toContain("$/a/b");
  });

  it("disambiguates shortened parent keys so children keep distinct names", () => {
    const shared = "p".repeat(128);
    const keyA = `${shared}${"A".repeat(100)}`;
    const keyB = `${shared}${"B".repeat(100)}`;
    const facts = canonicalizeArtifactFacts(
      Buffer.from(
        JSON.stringify({ [keyA]: { x: 1 }, [keyB]: { x: 2 } }),
        "utf8",
      ),
      "json",
      budget(),
    );
    const childNames = facts.core
      .map((fact) => fact.name)
      .filter((name): name is string => name !== null && name.endsWith("/x"));
    expect(childNames).toHaveLength(2);
    // Two keys that share their first 128 units must not collapse to one name.
    expect(new Set(childNames).size).toBe(2);
  });
});

// --- Fallback -------------------------------------------------------------

describe("engine selection", () => {
  it("retains identity and marks structure unverified for unknown formats", () => {
    const facts = canonicalizeArtifactFacts(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      "auto",
      budget(),
    );
    expect(facts.detected_format).toBe("unknown");
    expect(facts.normalizer).toBe("none");
    expect(facts.limitations.join(" ")).toMatch(/unverified/u);
  });

  it("reports a mismatch when an explicit format does not recognize the bytes", () => {
    const facts = canonicalizeArtifactFacts(
      Buffer.from("not wasm", "utf8"),
      "wasm",
      budget(),
    );
    expect(facts.coverage.status).toBe("partial");
    expect(facts.limitations.join(" ")).toMatch(/not a WASM|unverified/iu);
  });
});
