import { describe, expect, it } from "vitest";

import { functionDossierSchema } from "../../domain/native/functionDossier.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import { nativeApiBoundarySchema } from "../../domain/native/nativeApiBoundary.js";
import { projectNativeApiInspection } from "./NativeApiInspection.js";

describe("native API switch uncertainty", () => {
  it("reports an unevidenced default path independently of known numeric cases", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    if (table === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const incomplete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, default_targets: [] }],
      },
    });
    expect(projectNativeApiInspection(incomplete).residual_unknowns).toContain(
      "Which default or out-of-range path, if any, belongs to the dispatch at 0x401010?",
    );
  });

  it("does not report evidenced defaults as unknown cases and retains genuinely unresolved mappings", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const defaultTarget = {
      target_address: mapping.target_address,
      confidence: "high",
      evidence: mapping.evidence,
    };
    const complete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, default_targets: [defaultTarget] }],
      },
    });
    expect(projectNativeApiInspection(complete).residual_unknowns).toEqual([]);
    const unresolved = functionDossierSchema.parse({
      ...complete,
      native_api: {
        ...boundary,
        jump_tables: [
          {
            ...table,
            default_targets: [defaultTarget],
            mappings: [
              mapping,
              { ...mapping, case_value: null, target_address: "0x401030" },
            ],
          },
        ],
      },
    });
    expect(projectNativeApiInspection(unresolved).residual_unknowns).toContain(
      "Which source-level case values correspond to every target dispatched at 0x401010?",
    );
  });
});

describe("native API unresolved indirect branches", () => {
  const branchEvidence = [
    {
      kind: "indirect-branch",
      source: "ghidra-listing",
      detail: "Ghidra's listing marks br as a computed jump.",
    },
  ] as const;

  it("reports each unresolved indirect branch as a residual unknown", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const withBranches = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [
          {
            ...table,
            default_targets: [
              {
                target_address: mapping.target_address,
                confidence: "high",
                evidence: mapping.evidence,
              },
            ],
          },
        ],
        unresolved_indirect_branches: [
          {
            branch_address: "0x401040",
            decompiler_outcome: "jump_table_recovery_failed",
            listing_targets: [],
            evidence: branchEvidence,
          },
          {
            branch_address: "0x401050",
            decompiler_outcome: "no_jump_table_warning",
            listing_targets: ["0x401060"],
            evidence: branchEvidence,
          },
        ],
      },
    });

    const projected = projectNativeApiInspection(withBranches);
    expect(projected.unsupported_branches).toEqual([
      "indirect-branch-target-recovery",
    ]);
    expect(projected.residual_unknowns).toEqual([
      "Which targets can the indirect branch at 0x401040 reach? The decompiler could not recover a jump table there and rewrote it as a call or return; it may be a dispatch inside this function or an indirect tail call.",
      "Is the indirect branch at 0x401050 a tail call or a dispatch inside this function, and which targets can it reach?",
    ]);
  });

  it("keeps an inspected, empty branch inventory free of unknowns", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const projected = projectNativeApiInspection(
      functionDossierSchema.parse({
        ...dossier,
        native_api: { ...boundary, unresolved_indirect_branches: [] },
      }),
    );
    expect(projected.unsupported_branches).toEqual([]);
    expect(
      projected.residual_unknowns.some((unknown) =>
        unknown.includes("indirect branch"),
      ),
    ).toBe(false);
  });

  it("does not present an uninspected branch inventory as complete", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const { unresolved_indirect_branches: _omitted, ...uninspected } = boundary;
    const projected = projectNativeApiInspection(
      functionDossierSchema.parse({ ...dossier, native_api: uninspected }),
    );
    expect(projected.unsupported_branches).toEqual([
      "indirect-branch-inventory",
    ]);
    expect(projected.residual_unknowns).toContain(
      "Which indirect branches does this function contain? The provider did not report an indirect-branch inventory.",
    );
  });

  it("rejects an unresolved branch without evidence", () => {
    const boundary = functionDossierSchema.parse(
      ghidraFunctionDossier(),
    ).native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        unresolved_indirect_branches: [
          {
            branch_address: "0x401040",
            decompiler_outcome: "no_jump_table_warning",
            listing_targets: [],
            evidence: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("native API bounded indirect-branch inventory", () => {
  it("reports omitted branches as one residual unknown and retains omitted listing-target counts", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const bounded = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        unresolved_indirect_branches: [
          {
            branch_address: "0x401040",
            decompiler_outcome: "no_jump_table_warning",
            listing_targets: ["0x401060"],
            listing_targets_omitted: 3,
            evidence: [
              {
                kind: "indirect-branch",
                source: "ghidra-listing",
                detail: "Ghidra's listing marks br as a computed jump.",
              },
            ],
          },
        ],
        unresolved_indirect_branches_omitted: 7,
      },
    });
    const output = bounded.native_api;
    if (output?.available !== true)
      throw new TypeError("Bounded native API fixture is unavailable");
    expect(
      output.unresolved_indirect_branches?.[0]?.listing_targets_omitted,
    ).toBe(3);

    const projected = projectNativeApiInspection(bounded);
    expect(projected.unsupported_branches).toEqual([
      "indirect-branch-target-recovery",
    ]);
    expect(projected.residual_unknowns).toContain(
      "Which targets can the 7 further computed jump(s) in this function reach? The provider's indirect-branch inventory reached its bound and did not list them.",
    );
  });

  it.each([0, -1, 1.5])("rejects an omitted count of %s", (omitted) => {
    const boundary = functionDossierSchema.parse(
      ghidraFunctionDossier(),
    ).native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        unresolved_indirect_branches: [],
        unresolved_indirect_branches_omitted: omitted,
      }).success,
    ).toBe(false);
  });
});

describe("native API inspection", () => {
  it("preserves unsupported provider branches as residual unknowns", () => {
    const value = ghidraFunctionDossier();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Ghidra dossier fixture is invalid");
    const dossier = functionDossierSchema.parse({ ...value, native_api: null });
    const projected = projectNativeApiInspection(dossier);

    expect(projected).toMatchObject({
      boundary: { available: false },
      unsupported_branches: [
        "structured-boundary-types",
        "jump-table-data-mapping",
        "indirect-branch-inventory",
      ],
      residual_unknowns: [
        expect.stringContaining("boundary types"),
        expect.stringContaining("jump table"),
        "Which indirect branches does this function contain? The provider did not report an indirect-branch inventory.",
      ],
    });
    expect(projected.boundary).toMatchObject({
      reason:
        "The selected provider did not expose a structured native API boundary model.",
      residual_unknowns: [
        "What are the function's return and parameter boundary types?",
        "Does this function dispatch through a jump table with recoverable data addresses?",
      ],
    });
    expect(projected.residual_unknowns).toHaveLength(
      new Set(projected.residual_unknowns).size,
    );
    expect(projected.boundary).not.toHaveProperty(
      "unresolved_indirect_branches",
    );
  });

  it("adds missing branch-inventory uncertainty to an unavailable boundary without duplicating it", () => {
    const value = ghidraFunctionDossier();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Ghidra dossier fixture is invalid");
    const inventoryUnknown =
      "Which indirect branches does this function contain? The provider did not report an indirect-branch inventory.";
    const dossier = functionDossierSchema.parse({
      ...value,
      native_api: {
        available: false,
        reason: "Fixture provider omitted its native API boundary.",
        residual_unknowns: [
          "Provider-specific boundary limitation.",
          inventoryUnknown,
        ],
      },
    });

    const projected = projectNativeApiInspection(dossier);
    expect(projected.boundary).toMatchObject({
      available: false,
      reason: "Fixture provider omitted its native API boundary.",
      residual_unknowns: [
        "Provider-specific boundary limitation.",
        inventoryUnknown,
      ],
    });
    expect(projected.residual_unknowns).toEqual([
      "Provider-specific boundary limitation.",
      inventoryUnknown,
    ]);
    expect(projected.unsupported_branches).toEqual([
      "structured-boundary-types",
      "jump-table-data-mapping",
      "indirect-branch-inventory",
    ]);
  });

  it("reports missing jump-table targets as an explicit unknown", () => {
    const value = ghidraFunctionDossier();
    const dossier = functionDossierSchema.parse(value);
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    if (table === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");

    const incomplete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, mappings: [] }],
      },
    });
    expect(projectNativeApiInspection(incomplete).residual_unknowns).toContain(
      "Which case values and targets belong to the dispatch at 0x401010?",
    );
  });

  it("rejects boundary types placed in the wrong ABI role", () => {
    const boundary = functionDossierSchema.parse(
      ghidraFunctionDossier(),
    ).native_api;
    if (boundary === null || boundary.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");

    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        return_type: { ...boundary.return_type, role: "parameter" },
      }).success,
    ).toBe(false);
    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        parameters: [
          {
            ...boundary.return_type,
            role: "return",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
