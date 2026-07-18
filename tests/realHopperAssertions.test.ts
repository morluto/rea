import { describe, expect, it } from "vitest";

import {
  firstProcedureAddress,
  requireDistinctTargetHashes,
  requireAddressArray,
  requireFunctionDossierOracle,
  requireFunctionDossier,
  requirePseudocode,
} from "../src/application/RealHopperAssertions.js";

describe("real Hopper semantic assertions", () => {
  it("rejects two target paths containing the same binary", () => {
    expect(() => requireDistinctTargetHashes("same", "same")).toThrow(
      /distinct binaries/u,
    );
    expect(() => requireDistinctTargetHashes("", "other")).toThrow();
    expect(() => requireDistinctTargetHashes("first", "second")).not.toThrow();
  });
  it("extracts only a real procedure address from a structured page", () => {
    expect(
      firstProcedureAddress({
        items: [{ address: "0x1000", name: "main" }],
        offset: 0,
        limit: 100,
        total: 1,
        next_offset: null,
        has_more: false,
      }),
    ).toBe("0x1000");
    expect(() =>
      firstProcedureAddress({ items: { address: "0x1000" } }),
    ).toThrow();
    expect(() =>
      firstProcedureAddress({ items: [{ address: "items" }] }),
    ).toThrow();
  });

  it("rejects empty and embedded per-item decompilation failures", () => {
    expect(requirePseudocode("return 0;", "batch_decompile")).toBe("return 0;");
    for (const invalid of ["", "   ", "No output", "Error: invalid address"])
      expect(() => requirePseudocode(invalid, "batch_decompile")).toThrow();
  });

  it("requires address-shaped relationship evidence", () => {
    expect(requireAddressArray(["0x1000"], "xrefs")).toEqual(["0x1000"]);
    expect(() => requireAddressArray(["main"], "xrefs")).toThrow();
  });

  it("rejects success-shaped dossiers without truthful semantic content", () => {
    const dossier = validDossier();
    expect(requireFunctionDossier(dossier, "0x1000")).toEqual(dossier);
    expect(() =>
      requireFunctionDossier(
        {
          ...dossier,
          pseudocode: {
            text: "Error: failed",
            returned_chars: 13,
            total_chars: 13,
          },
        },
        "0x1000",
      ),
    ).toThrow(/embedded failure/u);
    expect(() =>
      requireFunctionDossier(
        { ...dossier, instruction_scan: { scanned: 0, truncated: false } },
        "0x1000",
      ),
    ).toThrow(/instruction scan/u);
  });

  it("counts Unicode code points and accepts terminal scan truncation", () => {
    const dossier = validDossier();
    const scanLimited = {
      ...dossier,
      pseudocode: { text: "😀", returned_chars: 1, total_chars: 1 },
      comments: {
        items: [],
        total: null,
        returned: 0,
        truncated: true,
        next_offset: null,
      },
      instruction_scan: { scanned: 1, truncated: true },
    };
    expect(requireFunctionDossier(scanLimited, "0x1000")).toEqual(scanLimited);
  });

  it("requires fixture-specific positive dossier evidence", () => {
    const entry = fixtureDossier({
      address: "0x1000",
      name: "rea_entry",
      callee: { address: "0x2000", name: "rea_branch" },
      caller: { address: "0x0900", name: "main" },
      referencedString: "REA_C_ENTRY",
      comment: "REA real-Hopper verifier",
      successor: "0x1010",
    });
    expect(
      requireFunctionDossierOracle(entry, {
        procedure_address: "0x1000",
        callee_address: "0x2000",
        caller_address: "0x0900",
        referenced_string: "REA_C_ENTRY",
        referenced_name: "rea_c_global",
        comment: "REA real-Hopper verifier",
        require_cfg_successor: true,
        require_assembly: true,
      }),
    ).toEqual(entry);

    for (const field of [
      "callees",
      "callers",
      "outgoing_references",
      "referenced_strings",
      "referenced_names",
      "comments",
      "assembly",
    ] as const) {
      expect(() =>
        requireFunctionDossierOracle(
          { ...entry, [field]: emptyCollection() },
          {
            procedure_address: "0x1000",
            callee_address: "0x2000",
            caller_address: "0x0900",
            referenced_string: "REA_C_ENTRY",
            referenced_name: "rea_c_global",
            comment: "REA real-Hopper verifier",
            require_cfg_successor: true,
            require_assembly: true,
          },
        ),
      ).toThrow();
    }
    expect(() =>
      requireFunctionDossierOracle(
        {
          ...entry,
          referenced_names: bounded([
            {
              address: "0x4000",
              value: "_rea_c_global",
              source_address: "0x2000",
            },
          ]),
        },
        {
          procedure_address: "0x1000",
          referenced_name: "rea_c_global",
        },
      ),
    ).toThrow();
    expect(() =>
      requireFunctionDossierOracle(
        {
          ...entry,
          basic_blocks: bounded([{ start: "0x1000", successors: [] }]),
        },
        {
          procedure_address: "0x1000",
          callee_address: "0x2000",
          referenced_string: "REA_C_ENTRY",
          comment: "REA real-Hopper verifier",
          require_cfg_successor: true,
        },
      ),
    ).toThrow(/CFG successor/u);
  });
});

const fixtureDossier = (input: {
  readonly address: string;
  readonly name: string;
  readonly callee: { readonly address: string; readonly name: string };
  readonly caller: { readonly address: string; readonly name: string };
  readonly referencedString: string;
  readonly comment: string;
  readonly successor: string;
}) => ({
  ...validDossier(),
  procedure: { address: input.address, name: input.name },
  assembly: bounded(["mov eax, eax"]),
  comments: bounded([
    { address: input.address, kind: "comment", text: input.comment },
  ]),
  callees: bounded([input.callee]),
  callers: bounded([input.caller]),
  outgoing_references: bounded([
    {
      source_address: input.address,
      target_address: input.callee.address,
      source_procedure: { address: input.address, name: input.name },
      target_procedure: input.callee,
      kind: { available: false, reason: "public API did not classify kind" },
    },
    {
      source_address: "0x1004",
      target_address: "0x3000",
      source_procedure: { address: input.address, name: input.name },
      target_procedure: null,
      kind: { available: false, reason: "public API did not classify kind" },
    },
    {
      source_address: "0x1008",
      target_address: "0x4000",
      source_procedure: { address: input.address, name: input.name },
      target_procedure: null,
      kind: { available: false, reason: "public API did not classify kind" },
    },
  ]),
  referenced_strings: bounded([
    {
      address: "0x3000",
      value: input.referencedString,
      source_address: "0x1004",
    },
  ]),
  referenced_names: bounded([
    {
      address: "0x4000",
      value: "_rea_c_global",
      source_address: "0x1008",
    },
  ]),
  basic_blocks: bounded([
    { start: input.address, successors: [input.successor] },
    { start: input.successor, successors: [] },
  ]),
});

const bounded = (items: readonly unknown[]) => ({
  items,
  total: items.length,
  returned: items.length,
  truncated: false,
  next_offset: null,
});

const emptyCollection = () => bounded([]);

const validDossier = () => {
  const collection = {
    items: [],
    total: 0,
    returned: 0,
    truncated: false,
    next_offset: null,
  };
  return {
    procedure: { address: "0x1000", name: "main" },
    pseudocode: { text: "return 0;", returned_chars: 9, total_chars: 9 },
    assembly: collection,
    comments: collection,
    callers: collection,
    callees: collection,
    incoming_references: collection,
    outgoing_references: collection,
    referenced_strings: collection,
    referenced_names: collection,
    basic_blocks: {
      ...collection,
      items: [{ successors: [] }],
      total: 1,
      returned: 1,
    },
    instruction_scan: { scanned: 1, truncated: false },
  };
};
