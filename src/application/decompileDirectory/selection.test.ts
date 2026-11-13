import { describe, expect, it } from "vitest";

import { selectProcedures, sortProcedureAddresses } from "./selection.js";

const input = {
  output_directory: "/tmp/decompile-order",
  layout: "address" as const,
  resume: false,
};
const bounds = { start: null, end: null };

describe("decompile directory selection", () => {
  it("preserves numeric order, address-space order, and alias tie breaks", () => {
    const selected = selectProcedures(
      [
        { address: "0x10", name: "later" },
        { address: "0x1", name: "zeta" },
        { address: "0x01", name: "alpha" },
        { address: "ram:0x2", name: "ram" },
        { address: "invalid-address", name: "unknown" },
        { address: "0x1", name: "duplicate" },
      ],
      input,
      bounds,
    );
    expect(selected.procedures.map((row) => row.address)).toEqual([
      "0x01",
      "0x1",
      "0x10",
      "ram:0x2",
      "invalid-address",
    ]);
    expect(selected.collapsedDuplicates).toBe(true);
    expect(selected.excluded).toBe(0);
  });

  it("still selects a later matching alias at the same address", () => {
    const selected = selectProcedures(
      [
        { address: "0x3", name: "other" },
        { address: "0x3", name: "wanted" },
        { address: "0x1", name: "wanted" },
      ],
      { ...input, name: "wanted" },
      bounds,
    );
    expect(selected.procedures).toEqual([
      { address: "0x1", name: "wanted" },
      { address: "0x3", name: "wanted" },
    ]);
    expect(selected.collapsedDuplicates).toBe(true);
    expect(selected.excluded).toBe(0);
  });
});

it("sorts journal records by numeric address without reordering equal coordinates", () => {
  const records = [
    { address: "ram:0x4", status: "written" },
    { address: "0x02", status: "first" },
    { address: "invalid", status: "unknown" },
    { address: "0x2", status: "second" },
    { address: "0x1", status: "entry" },
    { address: "rom:0x0", status: "rom" },
  ];
  expect(sortProcedureAddresses(records).map(({ status }) => status)).toEqual([
    "entry",
    "first",
    "second",
    "written",
    "rom",
    "unknown",
  ]);
  expect(sortProcedureAddresses(records.slice(0, 1))).toEqual(
    records.slice(0, 1),
  );
  expect(sortProcedureAddresses([])).toEqual([]);
});
