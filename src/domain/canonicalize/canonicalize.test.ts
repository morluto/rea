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

  it("collapses custom sections beyond the exemplar budget to counts", () => {
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

// --- ASAR -----------------------------------------------------------------

interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
}

const asarArchive = (
  files: Record<string, AsarNode>,
  content = Buffer.alloc(0),
  headerBufferOverride?: number,
): Buffer => {
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const header = Buffer.alloc(16);
  const headerBufferBytes = headerBufferOverride ?? 8 + json.length;
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerBufferBytes, 4);
  header.writeUInt32LE(headerBufferBytes - 4, 8);
  header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, json, content]);
};

describe("asar-header normalizer", () => {
  it("flags an abnormally long inventory path as unreferenced inflation", () => {
    const longName = `${"a".repeat(5000)}.js`;
    const bytes = asarArchive({
      "index.js": { size: 10, offset: "0" },
      [longName]: { size: 1, offset: "10" },
    });
    const facts = canonicalizeArtifactFacts(bytes, "auto", budget());
    expect(facts.detected_format).toBe("asar");
    expect(
      facts.collapsed.some(
        (fact) => fact.classification === "decoy-unreachable",
      ),
    ).toBe(true);
    expect(
      facts.reductions.some((entry) => entry.collection === "asar-decoy"),
    ).toBe(true);
  });

  it("marks entries reachable from package.json main as behavior-relevant", () => {
    const manifest = Buffer.from(JSON.stringify({ main: "index.js" }), "utf8");
    const index = Buffer.from("module.exports = 1;\n", "utf8");
    const content = Buffer.concat([manifest, index]);
    const bytes = asarArchive(
      {
        "package.json": { size: manifest.length, offset: "0" },
        "index.js": { size: index.length, offset: String(manifest.length) },
      },
      content,
    );
    const facts = canonicalizeArtifactFacts(bytes, "asar", budget());
    const reachable = facts.core.find((fact) => fact.name === "index.js");
    expect(reachable?.classification).toBe("behavior-relevant");
    expect(
      facts.core.find((fact) => fact.name === "package.json"),
    ).toBeDefined();
  });

  it("reports a header beyond REA's documented asar budget", () => {
    const bytes = asarArchive(
      { "index.js": { size: 1, offset: "0" } },
      Buffer.alloc(0),
      17 * 1024 * 1024,
    );
    const facts = canonicalizeArtifactFacts(bytes, "asar", budget());
    expect(facts.limitations.join(" ")).toMatch(/asar\.max_header_bytes/u);
  });
});

// --- JSON -----------------------------------------------------------------

describe("json-structure normalizer", () => {
  it("collapses nesting beyond max_depth and marks it truncated", () => {
    let nested = "0";
    for (let depth = 0; depth < 40; depth += 1) nested = `[${nested}]`;
    const facts = canonicalizeArtifactFacts(
      Buffer.from(nested, "utf8"),
      "auto",
      budget({ maxDepth: 8 }),
    );
    expect(facts.detected_format).toBe("json");
    expect(facts.coverage.truncated).toBe(true);
    expect(
      facts.reductions.some((entry) => entry.collection === "json-depth"),
    ).toBe(true);
  });

  it("reduces a high-cardinality sibling run to exemplars plus counts", () => {
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
      (entry) => entry.collection === "json-siblings",
    );
    expect(reduction?.collapsed).toBe(500 - 16);
    expect(facts.core[0]).toMatchObject({ collection: "json-root" });
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
