import { describe, expect, it } from "vitest";

import {
  classifyAsarInventory,
  reachableAsarPaths,
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
): AsarInventoryEntry => ({ path, kind: "file", size, limitations });

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

describe("reachableAsarPaths", () => {
  it("resolves main and exports from a package.json member", () => {
    const reachable = reachableAsarPaths(
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
  });

  it("leaves reachability unproven on a malformed manifest", () => {
    const reachable = reachableAsarPaths(Buffer.from("{ not json", "utf8"));
    expect(reachable.has("package.json")).toBe(true);
    expect(reachable.size).toBe(1);
  });
});
