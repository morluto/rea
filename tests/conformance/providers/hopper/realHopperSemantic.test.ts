import { describe, expect, it } from "vitest";

import {
  analyzeFixtureProcedure,
  requireCurrentDocument,
  resolveFixtureProcedure,
} from "../../../../scripts/lib/real-hopper-semantic.mjs";

const normalize = (value: unknown): unknown => value;

describe("Hopper verifier semantic fixture resolution", () => {
  it("binds mutations to the active document, not the first listed one", async () => {
    await expect(
      requireCurrentDocument(
        clientReturning("active"),
        {},
        ["unrelated", "active"],
        normalize,
      ),
    ).resolves.toBe("active");
    await expect(
      requireCurrentDocument(
        clientReturning("unknown"),
        {},
        ["unrelated", "active"],
        normalize,
      ),
    ).rejects.toThrow(/current_document/u);
  });

  it.each([
    ["empty", []],
    [
      "duplicate",
      [
        { address: "0x1000", value: "rea_entry" },
        { address: "0x2000", value: "_rea_entry" },
      ],
    ],
    ["wrong name", [{ address: "0x1000", value: "rea_other" }]],
  ])("rejects %s search evidence", async (_label, items) => {
    await expect(
      resolveFixtureProcedure(
        clientWithItems(items),
        {},
        "rea_entry",
        normalize,
      ),
    ).rejects.toThrow(/exactly one Hopper procedure/u);
  });
});

describe("Hopper verifier dossier coverage", () => {
  const procedure = { address: "0x1000", name: "rea_entry" };
  const normalizeStructured = (value: unknown) =>
    (value as { structuredContent?: unknown }).structuredContent ?? value;

  it("accepts the caller and callee coverage the provider declares", async () => {
    await expect(
      analyzeFixtureProcedure(
        clientWithDossier({
          status: "unknown",
          limited_directions: ["callers", "callees"],
          reason: "Independent public API inventories.",
        }),
        {},
        procedure,
        normalizeStructured,
      ),
    ).resolves.toMatchObject({ facet_availability: expect.any(Object) });
  });

  it.each([
    ["complete", { status: "complete" }],
    [
      "one direction",
      {
        status: "unknown",
        limited_directions: ["callers"],
        reason: "Callers only.",
      },
    ],
    [
      "no reason",
      { status: "unknown", limited_directions: ["callers", "callees"] },
    ],
  ])("rejects %s coverage", async (_label, coverage) => {
    await expect(
      analyzeFixtureProcedure(
        clientWithDossier(coverage),
        {},
        procedure,
        normalizeStructured,
      ),
    ).rejects.toThrow(/relationship|reason|Expected/u);
  });
});

const facetAvailability = () =>
  Object.fromEntries(
    [
      "pseudocode",
      "assembly",
      "comments",
      "callers",
      "callees",
      "references",
      "strings_names",
      "cfg",
    ].map((facet) => [facet, { available: true }]),
  );

const clientWithDossier = (relationshipCoverage: unknown) => {
  const structuredContent = {
    relationship_coverage: relationshipCoverage,
    facet_availability: facetAvailability(),
    outgoing_references: [],
  };
  // A declared coverage that leaves caller or callee discovery unestablished
  // makes compare_functions report the calls dimension as unknown, so the stub
  // derives it the way the comparison does rather than pinning one shape.
  const callsUnknown =
    (relationshipCoverage as { status?: string } | null)?.status !== "complete";
  return {
    callTool: async (request: { readonly name: string }) => {
      if (request.name === "analyze_function") return { structuredContent };
      return {
        structuredContent: {
          dimensions: [
            "identity",
            "pseudocode",
            "assembly",
            "comments",
            "calls",
            "references",
            "strings_names",
            "cfg",
          ].map((dimension) => ({
            dimension,
            status:
              dimension === "references" ||
              (dimension === "calls" && callsUnknown)
                ? "unknown"
                : "unchanged",
          })),
        },
      };
    },
  };
};

const clientWithItems = (items: readonly unknown[]) => ({
  callTool: async () => items,
});

const clientReturning = (value: unknown) => ({
  callTool: async () => value,
});
