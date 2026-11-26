import { int32LE as i4Value } from "../native/BinaryInteger.fixture.js";
import { describe, expect, it } from "vitest";
import { buildManagedPeFixture } from "../../scripts/fixtures/managed/pe.mjs";
import { managedPeFixtureTarget } from "./ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";

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
    token: "0x04000001",
    constant: {
      state: "decoded",
      element_type: "i4",
      value: 23942,
      raw_hex: "865d0000",
      declarations: [
        {
          row_offset: 0x3dc,
          type_code: 0x08,
          padding: 0,
          blob_index: 13,
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

  it("decodes an admitted default without reading the excluded type's malformed blob", () => {
    const bytes = buildManagedPeFixture({
      secondType: { name: "Excluded", firstField: 2 },
      fields: [
        { name: "Selected", flags: 0x8056 },
        { name: "Invalid", flags: 0x8056 },
      ],
      constants: [
        { typeCode: 8, parentRaw: 4, value: Buffer.from("01000000", "hex") },
        { typeCode: 8, parentRaw: 8, value: Buffer.from([1]) },
      ],
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
      { typeNames: ["Fixture.Program"] },
    );
    expect(result.selection?.unmatched_type_names).toEqual([]);
    expect(result.fields).toMatchObject([
      {
        token: "0x04000001",
        name: "Selected",
        constant: { state: "decoded", value: 1 },
      },
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });
});

it("distinguishes an observed ordinary field from historical omitted inspection", () => {
  const bytes = buildManagedPeFixture();
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.fields[0]?.constant).toBeNull();
  expect(result.coverage.state).toBe("complete");
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
          offset: 0x3dc,
          detail: expect.stringContaining(reason),
        }),
      ]),
    );
  },
);

it("binds unique and duplicate defaults to their selected fields in a non-monotonic table", () => {
  const bytes = buildManagedPeFixture({
    fields: ["F1", "F2", "F3", "F4"].map((name) => ({ name, flags: 0x8056 })),
    constants: (
      [
        [1, 100],
        [3, 300],
        [2, 200],
        [3, 301],
        [4, 400],
      ] as const
    ).map(([parent, value]) => ({
      typeCode: 8,
      parentRaw: parent << 2,
      value: i4Value(value),
    })),
  });
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    {
      typeNames: ["Fixture.Program"],
    },
  );

  expect(report.fields[1]).toMatchObject({
    token: "0x04000002",
    name: "F2",
    constant: { state: "decoded", value: 200, raw_hex: "c8000000" },
  });
  expect(report.fields[2]).toMatchObject({
    token: "0x04000003",
    name: "F3",
    constant: {
      state: "unavailable",
      value: null,
      raw_hex: null,
      declarations: [{ blob_index: 27 }, { blob_index: 37 }],
    },
  });
  expect(report.coverage).toMatchObject({
    state: "partial",
    issues: [{ code: "invalid-row", scope: "metadata.Constant:0x04000003" }],
  });
});
