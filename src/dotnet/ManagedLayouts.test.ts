import { expect, it } from "vitest";
import { compareManagedMembers } from "../domain/managed/managedMemberComparison.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedMemberPointerFixture,
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import {
  attachManagedDecodeBudget,
  ManagedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readTypeMemberListFacts } from "../domain/managed/managedTypeMemberLists.js";
import { readTypeDefinitions } from "../domain/managed/managedMemberInspectorCore.js";
import { parseManagedLayoutDeclarations } from "./ManagedLayouts.js";

type Options = Parameters<typeof buildManagedPeFixture>[0];

const inspect = (options: Options = {}) => {
  const bytes = buildManagedPeFixture(options);
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};

const compare = (left: Options, right: Options) =>
  compareManagedMembers(
    { evidenceId: `ev_${"1".repeat(64)}`, result: inspect(left) },
    { evidenceId: `ev_${"2".repeat(64)}`, result: inspect(right) },
  );

const explicit = {
  typeFlags: [0x0010_0011],
  classLayouts: [[0, 16, 1]],
  fieldLayouts: [[4, 1]],
} as const;

it("retains exact explicit-layout declarations with build-local coordinates", () => {
  const result = inspect(explicit);
  expect(result.coverage.state).toBe("complete");
  expect(result).toMatchObject({
    layout_declarations: {
      state: "complete",
      classes: [
        {
          token: "0x0f000001",
          parent_row: 1,
          type_token: "0x02000001",
          type_name: "Fixture.Program",
          packing_size: 0,
          class_size: 16,
        },
      ],
      fields: [
        {
          token: "0x10000001",
          field_row: 1,
          field_token: "0x04000001",
          declaring_type_token: "0x02000001",
          declaring_type: "Fixture.Program",
          field_name: "counter",
          offset_bytes: 4,
        },
      ],
      issues: [],
    },
  });
});

it.each([
  ["field offset", explicit, { ...explicit, fieldLayouts: [[8, 1]] }],
  ["declared size", explicit, { ...explicit, classLayouts: [[0, 24, 1]] }],
  [
    "packing",
    { typeFlags: [0x0010_0009], classLayouts: [[1, 0, 1]] },
    { typeFlags: [0x0010_0009], classLayouts: [[8, 0, 1]] },
  ],
  ["layout kind", {}, { typeFlags: [0x0010_0009] }],
] as const)(
  "compares a changed %s independently of the field signature",
  (_label, left, right) => {
    const result = compare(left, right);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).toMatchObject({ status: "changed" });
  },
);

it("keeps default packing and size as zero declarations, not computed runtime values", () => {
  const result = inspect({
    typeFlags: [0x0010_0009],
    classLayouts: [[0, 0, 1]],
  });
  expect(result).toMatchObject({
    layout_declarations: {
      state: "complete",
      classes: [{ packing_size: 0, class_size: 0 }],
      fields: [],
    },
  });
});

it("does not require a ClassLayout row for an explicit field offset", () => {
  expect(
    inspect({
      typeFlags: explicit.typeFlags,
      fieldLayouts: explicit.fieldLayouts,
    }),
  ).toMatchObject({
    layout_declarations: {
      state: "complete",
      classes: [],
      fields: [{ offset_bytes: 4 }],
    },
  });
});

it("keeps duplicate physical declarations and reports their ambiguity", () => {
  expect(
    inspect({
      ...explicit,
      classLayouts: [
        [0, 16, 1],
        [0, 32, 1],
      ],
      fieldLayouts: [
        [4, 1],
        [8, 1],
      ],
    }),
  ).toMatchObject({
    layout_declarations: {
      state: "partial",
      classes: [{ class_size: 16 }, { class_size: 32 }],
      fields: [{ offset_bytes: 4 }, { offset_bytes: 8 }],
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid-row" }),
      ]),
    },
  });
});

it("keeps unrelated source metadata changes unchanged when the layout declaration is equal", () => {
  const result = compare(
    { ...explicit, mvid: Buffer.alloc(16, 1) },
    { ...explicit, mvid: Buffer.alloc(16, 2) },
  );
  expect(result.fields[0]).toMatchObject({ status: "unchanged" });
});

it("compares omitted class-size/packing directives like explicit zero defaults", () => {
  expect(
    compare(
      { typeFlags: [0x0010_0009] },
      { typeFlags: [0x0010_0009], classLayouts: [[0, 0, 1]] },
    ).fields[0]?.status,
  ).toBe("unchanged");
});

it.each([
  ["invalid parent", { ...explicit, classLayouts: [[0, 16, 0]] }],
  ["invalid field", { ...explicit, fieldLayouts: [[4, 2]] }],
  ["explicit packing", { ...explicit, classLayouts: [[8, 16, 1]] }],
  [
    "sequential packing",
    { typeFlags: [0x0010_0009], classLayouts: [[3, 16, 1]] },
  ],
  ["auto-layout size", { classLayouts: [[0, 16, 1]] }],
  ["interface size", { typeFlags: [0x0010_0029], classLayouts: [[0, 16, 1]] }],
  ["static field offset", { ...explicit, fieldFlags: 0x11 }],
] as const)(
  "retains %s declarations without claiming valid layout",
  (_label, options) => {
    const report = inspect(options);
    expect(report.layout_declarations?.state).toBe("partial");
    expect(report.layout_declarations?.issues).not.toHaveLength(0);
    expect(report.coverage.state).toBe("complete");
    expect(report.fields).toHaveLength(1);
  },
);

it("preserves unknown layout in historical Evidence and cross-build comparison", () => {
  const legacy = inspect({ ...explicit, mvid: Buffer.alloc(16, 1) });
  delete legacy.layout_declarations;
  expect(managedMemberInspectionSchema.parse(legacy)).not.toHaveProperty(
    "layout_declarations",
  );
  const compared = compareManagedMembers(
    { evidenceId: `ev_${"1".repeat(64)}`, result: legacy },
    { evidenceId: `ev_${"2".repeat(64)}`, result: inspect(explicit) },
  );
  expect(compared.fields[0]).toMatchObject({
    status: "unknown",
    limitations: [
      expect.objectContaining({ code: "layout-declarations-unavailable" }),
    ],
  });
});

it("does not treat a missing explicit field offset as an observed zero", () => {
  expect(
    compare(
      { typeFlags: explicit.typeFlags, mvid: Buffer.alloc(16, 1) },
      { ...explicit, fieldLayouts: [[0, 1]] },
    ).fields[0]?.status,
  ).toBe("unknown");
});

it("does not apply a type's instance layout to a static field", () => {
  expect(
    compare(
      { typeFlags: [0x0010_0009], fieldFlags: 0x11, classLayouts: [[1, 4, 1]] },
      {
        typeFlags: [0x0010_0009],
        fieldFlags: 0x11,
        classLayouts: [[8, 32, 1]],
      },
    ).fields[0]?.status,
  ).toBe("unchanged");
});

it("retains overlapping explicit fields as declarations rather than rejecting a union", () => {
  expect(
    inspect({
      ...explicit,
      fieldRowCount: 2,
      distinctMemberNames: true,
      fieldLayouts: [
        [0, 1],
        [0, 2],
      ],
    }).layout_declarations,
  ).toMatchObject({
    state: "complete",
    fields: [{ offset_bytes: 0 }, { offset_bytes: 0 }],
    issues: [],
  });
});

it("applies type selection and leaves layout inventory independent of MethodDef paging", () => {
  const bytes = buildManagedPeFixture({
    additionalEmptyTypes: 1,
    typeFlags: [0x0010_0011, 0x0010_0011],
    fieldRowCount: 2,
    firstTypeFieldRowCount: 1,
    distinctMemberNames: true,
    classLayouts: [
      [0, 8, 1],
      [0, 16, 2],
    ],
    fieldLayouts: [
      [0, 1],
      [4, 2],
    ],
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    { typeNames: ["Fixture.Program"], methodLimit: 0 },
  );
  expect(result.methods).toEqual([]);
  expect(result.layout_declarations).toMatchObject({
    state: "complete",
    classes: [{ token: "0x0f000002", parent_row: 2 }],
    fields: [{ token: "0x10000002", field_row: 2, offset_bytes: 4 }],
  });
  expect(result.layout_declarations?.classes).toHaveLength(1);
  expect(result.layout_declarations?.fields).toHaveLength(1);
});

it("resolves physical FieldLayout RIDs through reordered FieldPtr ownership", () => {
  const bytes = buildManagedMemberPointerFixture({
    fieldLayouts: [
      [12, 1],
      [4, 2],
    ],
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    { typeNames: ["Fixture.A"] },
  );
  expect(result.layout_declarations).toMatchObject({
    state: "complete",
    fields: [
      {
        token: "0x10000002",
        field_row: 2,
        field_token: "0x04000002",
        declaring_type: "Fixture.A",
        field_name: "secondField",
        offset_bytes: 4,
      },
    ],
  });
  expect(result.layout_declarations?.fields).toHaveLength(1);
});

it("reads a four-byte physical Field RID without narrowing it to a list position", () => {
  const bytes = buildManagedPeFixture({
    typeFlags: explicit.typeFlags,
    fieldRowCount: 65_536,
    fieldLayouts: [[0x1234, 65_536]],
  });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Missing fixture metadata");
  const { rva, size } = pe.cli.metadata;
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "metadata"),
    size,
  );
  const members = readTypeMemberListFacts(bytes, layout);
  const types = readTypeDefinitions(bytes, layout, [], members);
  expect(layout.tableIndexSize(4)).toBe(4);
  expect(
    parseManagedLayoutDeclarations(bytes, layout, members, types, null),
  ).toMatchObject({
    state: "complete",
    fields: [
      {
        field_row: 65_536,
        field_token: "0x04010000",
        declaring_type_token: "0x02000001",
        offset_bytes: 0x1234,
      },
    ],
  });
});

it("preserves admitted member facts when layout declaration capacity is exhausted", () => {
  const bytes = buildManagedPeFixture({
    typeFlags: [0x100009],
    classLayouts: Array.from(
      { length: 100 },
      (_, index) => [1, index + 1, 1] as const,
    ),
  });
  const target = managedPeFixtureTarget(bytes);
  const limited = inspectManagedMembersBytes(bytes, target, {
    maxRepresentationBytes: 30_000,
  });
  const complete = inspectManagedMembersBytes(bytes, target);
  expect(limited.fields).toEqual(complete.fields);
  expect(limited.methods).toEqual(complete.methods);
  expect(limited.coverage.state).toBe("complete");
  expect(limited.layout_declarations).toMatchObject({
    state: "partial",
    classes: [],
    fields: [],
    issues: [
      {
        code: "resource-limit",
        scope: "metadata.layout",
        limit: {
          parameter: "max_metadata_representation_bytes",
          effective_value: 30_000,
        },
      },
    ],
  });
  expect(complete.layout_declarations?.classes).toHaveLength(100);
  const comparison = compareManagedMembers(
    { evidenceId: `ev_${"1".repeat(64)}`, result: limited },
    {
      evidenceId: `ev_${"2".repeat(64)}`,
      result: inspect({
        typeFlags: [0x100009],
        classLayouts: [[1, 1, 1]],
        mvid: Buffer.alloc(16, 1),
      }),
    },
  );
  expect(comparison.left.resource_limits).toEqual(
    limited.layout_declarations?.issues,
  );
  expect(comparison.right.resource_limits).toEqual([]);
  expect(comparison.coverage.left_status).toBe("complete");
  expect(comparison.limitations).toContainEqual(
    expect.stringContaining("left layout declarations exceeded capacity"),
  );
  expect(comparison.limitations).not.toContainEqual(
    expect.stringContaining("left managed member observation exceeded capacity"),
  );
});

it("does not spend selected-layout capacity on unselected declaration rows", () => {
  const bytes = buildManagedPeFixture({
    additionalEmptyTypes: 1,
    typeFlags: [0x0010_0011, 0x0010_0011],
    fieldRowCount: 2,
    firstTypeFieldRowCount: 1,
    distinctMemberNames: true,
    classLayouts: [
      ...Array.from({ length: 128 }, () => [0, 8, 1] as const),
      [0, 16, 2],
    ],
    fieldLayouts: [
      ...Array.from({ length: 128 }, () => [0, 1] as const),
      [4, 2],
    ],
  });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Missing fixture metadata");
  const { rva, size } = pe.cli.metadata;
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "metadata"),
    size,
  );
  const members = readTypeMemberListFacts(bytes, layout);
  const types = readTypeDefinitions(bytes, layout, [], members);
  // Admit the layout facet with a bounded remaining allowance: the skipped
  // rows alone would previously cost 256 * 256 bytes in row bookkeeping.
  attachManagedDecodeBudget(layout, new ManagedDecodeBudget(16 * 1024));
  expect(
    parseManagedLayoutDeclarations(
      bytes,
      layout,
      members,
      types,
      new Set(["0x02000002"]),
    ),
  ).toMatchObject({
    state: "complete",
    classes: [{ token: "0x0f000081", parent_row: 2 }],
    fields: [{ token: "0x10000081", field_row: 2, offset_bytes: 4 }],
    issues: [],
  });
});
