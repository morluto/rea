import { describe, expect, it } from "vitest";

import {
  classifyAsarInventory,
  reachableAsarPaths,
  MAX_ASAR_MANIFEST_BYTES,
  MAX_REACHABLE_PATHS,
  type AsarInventoryEntry,
} from "./asarInventory.js";
import {
  CANONICALIZE_SAMPLE_UNITS,
  canonicalizeArtifactSchema,
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

const context = (
  overrides: Partial<Parameters<typeof classifyAsarInventory>[2]> = {},
) => ({
  reachable: new Set<string>(),
  listingTruncated: false,
  ...overrides,
});

const entry = (
  path: string,
  size: number | null,
  limitations: readonly string[] = [],
  source: Partial<
    Pick<AsarInventoryEntry, "unpacked" | "executable" | "declaredIntegrity">
  > = {},
): AsarInventoryEntry => ({
  path,
  kind: "file",
  size,
  unpacked: false,
  executable: false,
  declaredIntegrity: null,
  limitations,
  ...source,
});

const longPath = `${"a".repeat(600)}.js`;

describe("classifyAsarInventory", () => {
  it("marks a proven-reachable long path behavior-relevant, not a decoy", () => {
    const facts = classifyAsarInventory(
      [entry("index.js", 10), entry(longPath, 5)],
      budget(),
      context({ reachable: new Set(["index.js", longPath]) }),
    );
    expect(facts.detected_format).toBe("asar");
    expect(facts.normalizer).toBe("asar-listing");
    // The reachable long path stays behavior-relevant; its inflated name is
    // folded to a bounded form with the exact path retained by digest.
    const longFact = facts.core.find(
      (fact) =>
        fact.classification === "behavior-relevant" && fact.name !== "index.js",
    );
    expect(longFact).toBeDefined();
    expect((longFact?.name ?? "").length).toBeLessThanOrEqual(256);
    expect(longFact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      facts.collapsed.some(
        (fact) => fact.classification === "decoy-unreachable",
      ),
    ).toBe(false);
  });

  it("flags an unreferenced long path as decoy inflation", () => {
    const facts = classifyAsarInventory(
      [entry(longPath, 5)],
      budget(),
      context(),
    );
    expect(
      facts.collapsed.some(
        (fact) => fact.classification === "decoy-unreachable",
      ),
    ).toBe(true);
    expect(
      facts.reductions.some(
        (reduction) => reduction.collection === "asar-decoy",
      ),
    ).toBe(true);
  });

  it("counts entries beyond the exemplar budget with a group digest", () => {
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      entry(`mod${String(index)}.js`, 1),
    );
    const facts = classifyAsarInventory(
      entries,
      budget({ maxFacts: 3 }),
      context(),
    );
    const reduction = facts.reductions.find(
      (candidate) => candidate.collection === "asar-entry",
    );
    expect(reduction).toMatchObject({
      examined: 10,
      retained: 3,
      collapsed: 7,
    });
    expect(reduction?.group_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(facts.coverage.status).toBe("partial");
  });

  it("keeps an unknown declared size distinct from an empty file and surfaces its limitation", () => {
    const facts = classifyAsarInventory(
      [
        entry("weird.bin", null, [
          "ASAR entry declares a negative size, which is not a non-negative safe integer.",
        ]),
      ],
      budget(),
      context({ reachable: new Set(["weird.bin"]) }),
    );
    const fact = facts.core.find((candidate) => candidate.name === "weird.bin");
    expect(fact?.bytes).toBe(0);
    expect(fact?.detail).toMatch(/size is unknown/iu);
    expect(facts.limitations.join(" ")).toMatch(/negative size/iu);
  });

  it("bounds an oversized per-entry limitation and retains it by digest", () => {
    const huge = "x".repeat(2_000_000);
    const facts = classifyAsarInventory(
      [entry("a.js", 1, [huge])],
      budget(),
      context({ reachable: new Set(["a.js"]) }),
    );
    const joined = facts.limitations.join("");
    // The multi-megabyte note cannot reach the result unbounded.
    expect(joined.length).toBeLessThan(10_000);
    expect(joined).toMatch(/sha256 [a-f0-9]{64}/u);
  });

  it("reports a truncated listing with the reader's own guidance", () => {
    const facts = classifyAsarInventory([], budget(), {
      reachable: new Set(),
      listingTruncated: true,
      extraLimitations: [
        "ASAR expanded listing exceeds its budget; set asar.max_listing_bytes.",
      ],
    });
    expect(facts.coverage.status).toBe("partial");
    expect(facts.coverage.truncated).toBe(true);
    expect(facts.limitations[0]).toMatch(/asar\.max_listing_bytes/u);
  });

  it("distinguishes a packed entry from an unpacked one of the same path and size", () => {
    const packed = classifyAsarInventory(
      [entry("app.js", 100)],
      budget(),
      context({ reachable: new Set(["app.js"]) }),
    );
    const unpacked = classifyAsarInventory(
      [entry("app.js", 100, [], { unpacked: true })],
      budget(),
      context({ reachable: new Set(["app.js"]) }),
    );
    const packedFact = packed.core.find((fact) => fact.name === "app.js");
    const unpackedFact = unpacked.core.find((fact) => fact.name === "app.js");
    // Same path and size, but the unpacked member's bytes live outside the
    // archive, so the facts must not be identical.
    expect(unpackedFact?.detail).not.toBe(packedFact?.detail);
    expect(unpackedFact?.detail).toMatch(/unpacked/iu);
    expect(unpackedFact?.detail).toMatch(/outside this archive/iu);
  });

  it("surfaces the executable bit and an unvalidated integrity declaration", () => {
    const facts = classifyAsarInventory(
      [
        entry("bin/tool", 200, [], {
          executable: true,
          declaredIntegrity: { algorithm: "sha256", digest: "a".repeat(64) },
        }),
      ],
      budget(),
      context({ reachable: new Set(["bin/tool"]) }),
    );
    const fact = facts.core.find((candidate) => candidate.name === "bin/tool");
    expect(fact?.detail).toMatch(/executable bit/iu);
    expect(fact?.detail).toMatch(/sha256 integrity digest/iu);
  });

  it("accepts a declared member size beyond 4 GiB in the fact schema", () => {
    const huge = classifyAsarInventory(
      [entry("model.bin", 5_000_000_000)],
      budget(),
      context({ reachable: new Set(["model.bin"]) }),
    );
    const parsed = canonicalizeArtifactSchema.parse({
      artifact: { path: "app.asar", sha256: "0".repeat(64), bytes: 1024 },
      requested_format: "asar",
      ...huge,
    });
    expect(parsed.core.find((fact) => fact.name === "model.bin")?.bytes).toBe(
      5_000_000_000,
    );
  });
});

describe("classifyAsarInventory aggregate byte limits", () => {
  it("saturates an over-limit collapsed byte total and keeps the result schema-valid", () => {
    // Two overflow members' declared sizes sum past safeCount's ceiling. Without
    // a cap collapsed_bytes exceeds the output schema and CanonicalizeService
    // returns AnalysisOutputError, discarding every retained fact. The aggregate
    // must saturate to the ceiling and disclose the over-limit state instead.
    const facts = classifyAsarInventory(
      [
        entry("a.js", 0),
        entry("b.js", Number.MAX_SAFE_INTEGER),
        entry("c.js", 1),
      ],
      budget({ maxFacts: 1 }),
      context({ reachable: new Set(["a.js", "b.js", "c.js"]) }),
    );
    const reduction = facts.reductions.find(
      (candidate) => candidate.collection === "asar-entry",
    );
    expect(reduction?.collapsed_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(facts.limitations.join(" ")).toMatch(/reportable maximum/u);
    expect(() =>
      canonicalizeArtifactSchema.parse({
        artifact: { path: "app.asar", sha256: "0".repeat(64), bytes: 1024 },
        requested_format: "asar",
        ...facts,
      }),
    ).not.toThrow();
  });

  it("saturates an over-limit decoy byte total and discloses it", () => {
    // Decoy aggregate sizes sum the same way; the decoy reduction must stay
    // schema-valid and report the saturated total as an explicit lower bound.
    const longA = `${"a".repeat(600)}.js`;
    const longB = `${"b".repeat(600)}.js`;
    const facts = classifyAsarInventory(
      [entry(longA, Number.MAX_SAFE_INTEGER), entry(longB, 1)],
      budget(),
      context(),
    );
    const reduction = facts.reductions.find(
      (candidate) => candidate.collection === "asar-decoy",
    );
    expect(reduction?.collapsed_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(facts.limitations.join(" ")).toMatch(/decoy inventory byte total/u);
  });
});

describe("reachableAsarPaths", () => {
  it("resolves main and exports from a package.json member", () => {
    const { reachable, limitation } = reachableAsarPaths(
      Buffer.from(
        JSON.stringify({
          main: "./dist/app.js",
          exports: { ".": "./index.js" },
        }),
        "utf8",
      ),
    );
    expect(reachable.has("package.json")).toBe(true);
    expect(reachable.has("dist/app.js")).toBe(true);
    expect(reachable.has("index.js")).toBe(true);
    expect(limitation).toBeUndefined();
  });

  it("leaves reachability unproven on a malformed manifest", () => {
    const { reachable } = reachableAsarPaths(Buffer.from("{ not json", "utf8"));
    expect(reachable.has("package.json")).toBe(true);
    expect(reachable.size).toBe(1);
  });

  it("does not parse a manifest beyond the fixed budget and reports it", () => {
    // A small header can declare a package.json holding most of the archive's
    // bytes; the pass must not decode and parse it whole.
    const oversized = Buffer.alloc(MAX_ASAR_MANIFEST_BYTES + 1, 0x20);
    const { reachable, limitation } = reachableAsarPaths(oversized);
    expect(reachable.has("package.json")).toBe(true);
    expect(reachable.size).toBe(1);
    expect(limitation).toMatch(/manifest budget/u);
  });

  it("caps retained reachable paths and reports partial reachability", () => {
    const exports: Record<string, string> = {};
    for (let index = 0; index <= MAX_REACHABLE_PATHS + 10; index += 1)
      exports[`./k${String(index)}`] = `./mod${String(index)}.js`;
    const { reachable, limitation } = reachableAsarPaths(
      Buffer.from(JSON.stringify({ exports }), "utf8"),
    );
    expect(reachable.size).toBeLessThanOrEqual(MAX_REACHABLE_PATHS);
    expect(limitation).toMatch(/reachability is partial/u);
  });
});
