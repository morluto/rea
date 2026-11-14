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
  headerBytesOverDocumentedLimit: null,
  listingTruncated: false,
  ...overrides,
});

const longPath = `${"a".repeat(600)}.js`;

describe("classifyAsarInventory", () => {
  it("marks a proven-reachable long path behavior-relevant, not a decoy", () => {
    const entries: AsarInventoryEntry[] = [
      { path: "index.js", kind: "file", size: 10 },
      { path: longPath, kind: "file", size: 5 },
    ];
    const facts = classifyAsarInventory(
      entries,
      budget(),
      context({ reachable: new Set(["index.js", longPath]) }),
    );
    expect(facts.detected_format).toBe("asar");
    expect(facts.normalizer).toBe("asar-listing");
    expect(
      facts.core.find((fact) => fact.name === longPath)?.classification,
    ).toBe("behavior-relevant");
    expect(
      facts.collapsed.some(
        (fact) => fact.classification === "decoy-unreachable",
      ),
    ).toBe(false);
  });

  it("flags an unreferenced long path as decoy inflation", () => {
    const facts = classifyAsarInventory(
      [{ path: longPath, kind: "file", size: 5 }],
      budget(),
      context(),
    );
    expect(
      facts.collapsed.some(
        (fact) => fact.classification === "decoy-unreachable",
      ),
    ).toBe(true);
    expect(
      facts.reductions.some((entry) => entry.collection === "asar-decoy"),
    ).toBe(true);
  });

  it("counts entries beyond the exemplar budget with a group digest", () => {
    const entries: AsarInventoryEntry[] = Array.from(
      { length: 10 },
      (_unused, index) => ({
        path: `mod${String(index)}.js`,
        kind: "file",
        size: 1,
      }),
    );
    const facts = classifyAsarInventory(
      entries,
      budget({ maxFacts: 3 }),
      context(),
    );
    const reduction = facts.reductions.find(
      (entry) => entry.collection === "asar-entry",
    );
    expect(reduction).toMatchObject({
      examined: 10,
      retained: 3,
      collapsed: 7,
    });
    expect(reduction?.group_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(facts.coverage.status).toBe("partial");
  });

  it("reports a header beyond REA's documented budget without failing", () => {
    const facts = classifyAsarInventory(
      [{ path: "index.js", kind: "file", size: 1 }],
      budget(),
      context({
        reachable: new Set(["index.js"]),
        headerBytesOverDocumentedLimit: 17 * 1024 * 1024,
      }),
    );
    expect(facts.limitations.join(" ")).toMatch(/asar\.max_header_bytes/u);
  });

  it("accepts a declared member size beyond 4 GiB in the fact schema", () => {
    const huge = classifyAsarInventory(
      [{ path: "model.bin", kind: "file", size: 5_000_000_000 }],
      budget(),
      context({ reachable: new Set(["model.bin"]) }),
    );
    // The whole report, including the >4 GiB declared size, must validate.
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
