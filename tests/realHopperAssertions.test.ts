import { describe, expect, it } from "vitest";

import {
  firstProcedureAddress,
  requireAddressArray,
  requireFunctionDossier,
  requirePseudocode,
} from "../src/application/RealHopperAssertions.js";

describe("real Hopper semantic assertions", () => {
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
});

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
