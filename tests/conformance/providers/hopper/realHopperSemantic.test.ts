import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  requireCurrentDocument,
  resolveFixtureProcedure,
  verifyRealHopperFixture,
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

const clientWithItems = (items: readonly unknown[]) => ({
  callTool: async () => items,
});

const clientReturning = (value: unknown) => ({
  callTool: async () => value,
});

describe("Hopper verifier fixture receipt", () => {
  it("serializes counts from complete canonical dossier arrays", async () => {
    const dossiers = new Map([
      ["entry", receiptDossier("entry", "main", "branch", "ENTRY")],
      ["branch", receiptDossier("branch", "entry", "leaf", "BRANCH")],
      ["leaf", receiptDossier("leaf", "branch", "main", "LEAF")],
    ]);
    const client = {
      async callTool(request: { name: string; arguments: unknown }) {
        const input = z
          .object({
            pattern: z.string().optional(),
            procedure: z.string().optional(),
          })
          .parse(request.arguments);
        if (request.name === "search_procedures")
          return [
            { address: receiptAddress(input.pattern), value: input.pattern },
          ];
        if (request.name === "set_comment") return true;
        if (request.name === "compare_functions")
          return {
            dimensions: Object.keys(receiptFacets)
              .concat("identity")
              .map((dimension) => ({
                dimension,
                // Unknown caller/callee coverage leaves calls unknown too.
                status:
                  dimension === "references" || dimension === "calls"
                    ? "unknown"
                    : "unchanged",
              })),
          };
        const dossier = [...dossiers.values()].find(
          (value) => value.procedure.address === input.procedure,
        );
        if (dossier === undefined) throw new Error("Unknown fixture procedure");
        if (request.name === "analyze_function")
          return {
            normalized_result: dossier,
            structuredContent: {
              // The coverage the Hopper provider declares for analyze_function.
              relationship_coverage: {
                status: "unknown",
                limited_directions: ["callers", "callees"],
                reason: "Hopper caller and callee completeness is unknown.",
              },
            },
          };
        if (request.name === "procedure_references")
          return {
            references: dossier.outgoing_references,
            unresolved_calls: [],
            reference_kinds_available: false,
          };
        throw new Error(`Unexpected fixture operation: ${request.name}`);
      },
    };
    const result = await verifyRealHopperFixture({
      client,
      options: {},
      document: "inert-fixture",
      oracle: {
        mainProcedure: "main",
        entryProcedure: "entry",
        branchProcedure: "branch",
        leafProcedure: "leaf",
        entryString: "ENTRY",
        leafString: "LEAF",
        globalName: "global",
      },
      normalizedResult(value: unknown) {
        return value !== null &&
          typeof value === "object" &&
          "normalized_result" in value
          ? value.normalized_result
          : value;
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      procedures: Object.fromEntries(
        ["main", "entry", "branch", "leaf"].map((name) => [
          name,
          { name, address: receiptAddress(name) },
        ]),
      ),
      entryComments: 1,
      entryStrings: 1,
      entryCallees: 1,
      branchCallees: 1,
      branchBlocks: 2,
      leafStrings: 1,
      leafNames: 1,
    });
  });
});

const receiptFacets = Object.fromEntries(
  [
    "pseudocode",
    "assembly",
    "comments",
    "calls",
    "references",
    "strings_names",
    "cfg",
  ].map((facet) => [facet, { available: true }]),
);
const receiptAddress = (name: string | undefined) => {
  const index = ["main", "entry", "branch", "leaf"].indexOf(name ?? "");
  if (index < 0) throw new Error("Unknown fixture name");
  return `0x${(0x1000 + index * 0x1000).toString(16)}`;
};
const receiptDossier = (
  name: string,
  caller: string,
  callee: string,
  text: string,
) => {
  const address = receiptAddress(name);
  return {
    procedure: { address, name },
    pseudocode: "return 1;",
    assembly: ["ret"],
    comments: [
      {
        address,
        kind: "comment",
        text: "REA real-Hopper conformance verifier",
      },
    ],
    callers: [{ address: receiptAddress(caller), name: caller }],
    callees: [{ address: receiptAddress(callee), name: callee }],
    incoming_references: [],
    outgoing_references: [
      {
        source_address: address,
        target_address: receiptAddress(callee),
        call: {
          classification: "direct",
          provider_type: 2,
          provenance: "hopper-public-python-api:CallReference",
        },
        kind: { available: false },
      },
      { source_address: address, target_address: "0x5000" },
      { source_address: address, target_address: "0x6000" },
    ],
    referenced_strings: [
      { source_address: address, address: "0x5000", value: text },
    ],
    referenced_names: [
      { source_address: address, address: "0x6000", value: "global" },
    ],
    basic_blocks: [{ successors: ["0x3001"] }, { successors: [] }],
    unresolved_calls: [],
    facet_availability: {
      ...receiptFacets,
      callers: { available: true },
      callees: { available: true },
    },
  };
};
