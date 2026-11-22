import { describe, expect, it, vi } from "vitest";
import { buildManagedPeFixture } from "../../scripts/fixtures/managed/pe.mjs";
import { managedPeFixtureTarget } from "./ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { createManagedFieldConstantReader } from "./ManagedFieldConstants.js";
import { managedDecodeBudget } from "../domain/managed/managedDecodeBudget.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import {
  MANAGED_CODED_INDEXES,
  readManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { decodeMetadataCodedIndex } from "../domain/managed/managedMetadataHeaps.js";

const inspectConstant = (typeCode: number, hex: string) => {
  const bytes = buildManagedPeFixture({
    fields: [
      {
        name: "Default",
        flags: 0x8056,
        signature: Buffer.from(
          typeCode === 0x12 ? [0x06, 0x12, 0x05] : [0x06, typeCode],
        ),
      },
    ],
    constants: [{ typeCode, value: Buffer.from(hex, "hex") }],
  });
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};

it("retains an i4 field default with its Constant row and encoded bytes", () => {
  const bytes = buildManagedPeFixture({
    fields: [{ name: "WMGraphNotify", flags: 0x8056 }],
    constants: [{ typeCode: 0x08, value: Buffer.from("865d0000", "hex") }],
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.fields[0]).toMatchObject({
    name: "WMGraphNotify",
    constant: {
      state: "decoded",
      element_type: "i4",
      value: 23942,
      raw_hex: "865d0000",
      declarations: [
        {
          row_offset: expect.any(Number),
          type_code: 0x08,
          blob_index: expect.any(Number),
        },
      ],
      limitation: null,
    },
  });
});

describe("lossless field constant scalars", () => {
  it.each([
    [0x02, "boolean", "01", true],
    [0x03, "char", "00d8", "\ud800"],
    [0x04, "i1", "ff", -1],
    [0x05, "u1", "ff", 255],
    [0x06, "i2", "0080", -32768],
    [0x07, "u2", "ffff", 65535],
    [0x09, "u4", "ffffffff", 4294967295],
    [0x0a, "i8", "0000000000000080", "-9223372036854775808"],
    [0x0b, "u8", "ffffffffffffffff", "18446744073709551615"],
    [0x0c, "r4", "0000c03f", 1.5],
    [0x0d, "r8", "0000000000000080", "-0"],
    [0x0d, "r8", "000000000000f07f", "Infinity"],
    [0x0c, "r4", "0100c07f", "NaN"],
    [0x0e, "string", "4100000000d8", "A\0\ud800"],
    [0x0e, "string", "", ""],
    [0x12, "class", "00000000", null],
  ])(
    "retains encoded %s (%s) without JSON precision loss",
    (code, kind, hex, value) => {
      const result = inspectConstant(Number(code), String(hex));
      expect(result.fields[0]).toMatchObject({
        constant: {
          state: "decoded",
          element_type: kind,
          raw_hex: hex,
          value,
          limitation: null,
        },
      });
      expect(result.coverage.state).toBe("complete");
    },
  );
});

describe("unavailable field defaults retain independent facts", () => {
  it.each([
    [0x08, "01"],
    [0x02, "02"],
    [0x0e, "41"],
    [0x12, "01000000"],
    [0x55, "01"],
  ])("keeps invalid type/bytes %s/%s explicit", (code, hex) => {
    const result = inspectConstant(code, hex);
    expect(result.fields[0]).toMatchObject({
      name: "Default",
      constant: {
        state: "unavailable",
        value: null,
        raw_hex: hex,
        limitation: expect.any(String),
      },
    });
    expect(result.methods[0]?.name).toBe("Main");
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "metadata.Constant:0x04000001" }),
      ]),
    );
  });

  it.each([
    { flags: 0x8056, constants: [], count: 0 },
    {
      flags: 0x0056,
      constants: [{ typeCode: 8, value: Buffer.from("01000000", "hex") }],
      count: 1,
    },
    {
      flags: 0x8056,
      constants: [1, 2].map(() => ({
        typeCode: 8,
        value: Buffer.from("01000000", "hex"),
      })),
      count: 2,
    },
    {
      flags: 0x8056,
      constants: [
        { typeCode: 8, padding: 1, value: Buffer.from("01000000", "hex") },
      ],
      count: 1,
    },
  ])(
    "does not choose a value from contradictory declarations %#",
    ({ flags, constants, count }) => {
      const bytes = buildManagedPeFixture({
        fields: [{ name: "Declared", flags }],
        constants,
      });
      const result = inspectManagedMembersBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      expect(result.fields[0]).toMatchObject({
        constant: { state: "unavailable", value: null },
      });
      expect(result.fields[0]?.constant?.declarations).toHaveLength(count);
      expect(result.coverage.state).toBe("partial");
    },
  );

  it("keeps an ordinary field distinct from historical unexamined Evidence", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.fields[0]?.constant).toBeNull();
    expect(result.coverage.state).toBe("complete");
  });

  it("does not decode an excluded field's malformed default", () => {
    const bytes = buildManagedPeFixture({
      fields: [{ name: "Excluded", flags: 0x8056 }],
      constants: [{ typeCode: 8, value: Buffer.from([1]) }],
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
      { typeNames: ["Missing"] },
    );
    expect(result.fields).toEqual([]);
    expect(
      result.coverage.issues.some(({ scope }) =>
        scope.startsWith("metadata.Constant"),
      ),
    ).toBe(false);
  });
});

it("refuses member Evidence whose fields omit the constant inspection", () => {
  const result = inspectConstant(8, "01000000");
  const fields = result.fields.map(
    ({ constant: _constant, ...field }) => field,
  );
  expect(
    managedMemberInspectionSchema.safeParse({ ...result, fields }).error
      ?.issues[0]?.path,
  ).toEqual(["fields", 0, "constant"]);
});

it.each([
  { parentRaw: 7, reason: "tag 3" },
  { parentRaw: 8, reason: "row 2" },
])(
  "retains the coded-index diagnostic for invalid parent $parentRaw",
  ({ parentRaw, reason }) => {
    const bytes = buildManagedPeFixture({
      fields: [{ name: "Default", flags: 0x8056 }],
      constants: [
        { typeCode: 8, parentRaw, value: Buffer.from("01000000", "hex") },
      ],
    });
    const definition = MANAGED_CODED_INDEXES.HasConstant;
    const counts: number[] = [];
    counts[4] = 1;
    const parent = decodeMetadataCodedIndex(
      parentRaw,
      definition.bits,
      definition.tables,
      counts,
    );
    expect(parent).toMatchObject({
      kind: "invalid",
      row: parentRaw === 7 ? 1 : 2,
    });
    if (parent.kind !== "invalid")
      throw new Error("Expected invalid fixture parent");
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.fields[0]?.constant?.state).toBe("unavailable");
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-row",
          scope: "metadata.Constant",
          detail: expect.stringContaining(reason),
        }),
      ]),
    );
  },
);

const i4Value = (n: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(n, 0);
  return buf;
};

describe("binary-search Constant lookup under type selection", () => {
  const layoutOf = (bytes: Buffer) => {
    const pe = readManagedPeLayout(bytes);
    if (pe.cli === null) throw new Error("Expected CLI metadata");
    return readManagedMetadataLayout(
      bytes,
      pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
      pe.cli.metadata.size,
    );
  };

  it("handles boundary hits, duplicates, and misses without reserving unrelated Constant rows", () => {
    const bytes = buildManagedPeFixture({
      fields: Array.from({ length: 6 }, (_, index) => ({
        name: `F${String(index + 1)}`,
        flags: 0x8056,
      })),
      // Sorted HasConstant coded keys: Field 2 (8), Param 2 (9), Field 4 (16 x2), Field 5 (20).
      constants: [
        { typeCode: 0x08, parentRaw: 2 << 2, value: i4Value(20) },
        { typeCode: 0x08, parentRaw: (2 << 2) | 1, value: i4Value(999) },
        { typeCode: 0x08, parentRaw: 4 << 2, value: i4Value(40) },
        { typeCode: 0x08, parentRaw: 4 << 2, value: i4Value(41) },
        { typeCode: 0x08, parentRaw: 5 << 2, value: i4Value(50) },
      ],
    });
    const layout = layoutOf(bytes);
    const budget = managedDecodeBudget(layout);
    const reserveRow = vi.spyOn(budget, "reserveRow");
    const issues: Parameters<typeof createManagedFieldConstantReader>[2] = [];
    const read = createManagedFieldConstantReader(bytes, layout, issues, {
      selected: true,
    });

    // Misses: below min (Field 1 -> 4), gap (Field 3 -> 12), above max (Field 6 -> 24).
    expect(read(1, 0x0056)).toBeNull();
    expect(read(3, 0x0056)).toBeNull();
    expect(read(6, 0x0056)).toBeNull();
    expect(reserveRow).not.toHaveBeenCalled();

    // First hit (Field 2) and last hit (Field 5): only those matching Constant rows are reserved.
    expect(read(2, 0x8056)).toMatchObject({ state: "decoded", value: 20 });
    expect(read(5, 0x8056)).toMatchObject({ state: "decoded", value: 50 });
    expect(reserveRow.mock.calls.map(([table, row]) => [table, row])).toEqual([
      [11, 1],
      [11, 5],
    ]);

    // Duplicate Constant rows for middle Field 4: both are collected cleanly.
    const dup = read(4, 0x8056);
    expect(dup).toMatchObject({ state: "unavailable", value: null });
    expect(dup?.declarations).toHaveLength(2);
    expect(issues).toEqual([
      expect.objectContaining({ scope: "metadata.Constant:0x04000004" }),
    ]);
  });

  it("handles an empty Constant table under selected lookup", () => {
    const bytes = buildManagedPeFixture({
      fields: [{ name: "F1", flags: 0x0056 }],
      constants: [],
    });
    const layout = layoutOf(bytes);
    const read = createManagedFieldConstantReader(bytes, layout, [], {
      selected: true,
    });
    expect(read(1, 0x0056)).toBeNull();
  });

  it("falls back cleanly to linear indexing when Constant rows are non-monotonic", () => {
    const bytes = buildManagedPeFixture({
      fields: [
        { name: "F1", flags: 0x8056 },
        { name: "F2", flags: 0x8056 },
        { name: "F3", flags: 0x8056 },
      ],
      // Decreasing Parent keys: Field 3 (12), Field 1 (4), Field 2 (8).
      constants: [
        { typeCode: 0x08, parentRaw: 3 << 2, value: i4Value(300) },
        { typeCode: 0x08, parentRaw: 1 << 2, value: i4Value(100) },
        { typeCode: 0x08, parentRaw: 2 << 2, value: i4Value(200) },
      ],
    });
    const layout = layoutOf(bytes);
    const issues: Parameters<typeof createManagedFieldConstantReader>[2] = [];
    const read = createManagedFieldConstantReader(bytes, layout, issues, {
      selected: true,
    });

    expect(read(1, 0x8056)).toMatchObject({ state: "decoded", value: 100 });
    expect(read(2, 0x8056)).toMatchObject({ state: "decoded", value: 200 });
    expect(read(3, 0x8056)).toMatchObject({ state: "decoded", value: 300 });
    expect(issues).toEqual([]);
  });
});
