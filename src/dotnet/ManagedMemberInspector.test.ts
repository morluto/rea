import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { ManagedDecodeBudget } from "./ManagedDecodeBudget.js";
import { edges } from "./ManagedMemberRows.js";
import { signature, type ManagedMethod } from "./ManagedMemberInspectorCore.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { comparisonLimitations } from "../domain/managed/managedMemberComparisonCoverage.js";

import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

describe("managed member inspection", () => {
  it("keeps metadata handles distinct from calls and field accesses", () => {
    const il = Buffer.from([
      0xd0, 0x01, 0, 0, 0x06, 0x26, 0xd0, 0x01, 0, 0, 0x04, 0x26, 0x28, 0x01, 0,
      0, 0x0a, 0x7b, 0x01, 0, 0, 0x04, 0x26, 0x2a,
    ]);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.methods[0]?.body.anchors.map(({ opcode }) => opcode)).toEqual(
      ["ldtoken", "ldtoken", "call", "ldfld"],
    );
    expect(result.call_edges.map(({ opcode }) => opcode)).toEqual(["call"]);
    expect(result.field_accesses.map(({ opcode }) => opcode)).toEqual([
      "ldfld",
    ]);
  });

  it("inspects metadata members, signatures, CIL hashes, call edges, and field anchors", () => {
    const bytes = buildManagedPeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.identity_scope).toEqual({
      token_identity: "build-local",
      requires_artifact_sha256: managedPeFixtureTarget(bytes).sha256,
      requires_mvid: "00112233-4455-6677-8899-aabbccddeeff",
    });
    expect(result.types).toEqual([
      expect.objectContaining({
        token: "0x02000001",
        full_name: "Fixture.Program",
        field_list: { first_row: 1, last_row: 1, count: 1 },
        method_list: { first_row: 1, last_row: 1, count: 1 },
      }),
    ]);
    expect(result.fields).toEqual([
      expect.objectContaining({
        token: "0x04000001",
        declaring_type: "Fixture.Program",
        name: "counter",
        signature: expect.objectContaining({
          kind: "field",
          parse_status: "decoded",
          field_type: "i4",
        }),
      }),
    ]);
    expect(result.methods).toEqual([
      expect.objectContaining({
        token: "0x06000001",
        declaring_type: "Fixture.Program",
        name: "Main",
        rva: 0x2800,
        signature: expect.objectContaining({
          kind: "method",
          parse_status: "decoded",
          return_type: "void",
          parameter_types: [],
        }),
        body: expect.objectContaining({
          status: "present",
          header_format: "tiny",
          file_offset: 0x0a00,
          il_size: 12,
          instruction_count: 4,
          decoded_instruction_count: 4,
          truncated_instructions: 0,
          opcode_counts: { "ldarg.0": 1, ldfld: 1, call: 1, ret: 1 },
          anchors: [
            {
              il_offset: 1,
              opcode: "ldfld",
              operand_kind: "field",
              operand: "0x04000001",
            },
            {
              il_offset: 6,
              opcode: "call",
              operand_kind: "method",
              operand: "0x0a000001",
            },
          ],
        }),
      }),
    ]);
    expect(result.member_refs).toEqual([
      expect.objectContaining({
        token: "0x0a000001",
        name: ".ctor",
        signature: expect.objectContaining({
          kind: "method",
          parse_status: "decoded",
          parameter_types: ["string"],
        }),
      }),
    ]);
    expect(result.call_edges).toEqual([
      {
        caller_token: "0x06000001",
        caller: "Fixture.Program.Main",
        opcode: "call",
        target_token: "0x0a000001",
        target_kind: "member-ref",
        target_name: ".ctor",
      },
    ]);
    expect(result.field_accesses).toEqual([
      {
        method_token: "0x06000001",
        method: "Fixture.Program.Main",
        opcode: "ldfld",
        field_token: "0x04000001",
        field_name: "counter",
      },
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });
});

describe("managed exported types", () => {
  it("reports type forwarders and nested exported types with their implementation scope", () => {
    const bytes = buildManagedPeFixture({
      exportedTypes: [
        {
          namespace: "System",
          name: "Object",
          flags: 0x0020_0001,
          implementationRaw: (1 << 2) | 1,
        },
        {
          namespace: "",
          name: "Enumerator",
          flags: 0x0000_0002,
          implementationRaw: (1 << 2) | 2,
        },
      ],
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.metadata.table_row_counts).toMatchObject({
      ExportedType: 2,
    });
    expect(result.exported_types).toMatchObject([
      {
        token: "0x27000001",
        namespace: "System",
        name: "Object",
        flags: 0x0020_0001,
        forwarder: true,
        type_def_id: 0,
        implementation_token: "0x23000001",
      },
      {
        token: "0x27000002",
        namespace: "",
        name: "Enumerator",
        forwarder: false,
        implementation_token: "0x27000001",
      },
    ]);
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
  });

  it("leaves exported types unknown when CLI metadata is unavailable", () => {
    const bytes = buildNativePeFixture();
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.coverage.state).toBe("unavailable");
    expect(result.exported_types).toBeNull();
  });

  it("reads member Evidence recorded before exported types as unexamined", () => {
    const bytes = buildManagedPeFixture();
    const { exported_types: _omitted, ...legacy } = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const parsed = managedMemberInspectionSchema.parse(legacy);

    expect(parsed.exported_types).toBeNull();
    expect(comparisonLimitations(parsed, parsed)).toContain(
      "At least one managed member observation predates ExportedType inspection; its exported and forwarded types are unknown.",
    );
  });

  it("retains an exported type whose implementation is out of range as partial", () => {
    const bytes = buildManagedPeFixture({
      exportedTypes: [
        {
          namespace: "System",
          name: "Object",
          flags: 0x0020_0001,
          implementationRaw: (9 << 2) | 1,
        },
      ],
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.exported_types).toMatchObject([
      { token: "0x27000001", name: "Object", implementation_token: null },
    ]);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        {
          code: "invalid-row",
          scope: "metadata.ExportedType:0x27000001",
          detail: expect.stringContaining(
            "ExportedType implementation coded index 0x25 is invalid",
          ),
        },
      ],
    });
  });
});

describe("managed member decoding budget", () => {
  it("admits a wide-instruction method whose actual records fit the budget", () => {
    // Five-byte branches all target the next instruction. A final ret leaves
    // the method stack-neutral, despite over 256 KiB of valid IL bytes.
    const il = Buffer.alloc(270_001);
    for (let offset = 0; offset < il.length - 1; offset += 5) {
      il[offset] = 0x38;
    }
    il[il.length - 1] = 0x2a;
    const header = Buffer.alloc(12);
    header.writeUInt16LE(0x3003, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([header, il]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
    expect(result.types).toHaveLength(1);
    expect(result.methods[0]?.body).toMatchObject({
      status: "present",
      il_size: il.length,
      decoded_instruction_count: 54_001,
      opcode_counts: { br: 54_000, ret: 1 },
    });
  });

  it("still rejects dense one-byte instructions before exceeding capacity", () => {
    // All NOPs: unlike wide instructions, each IL byte adds a decoded record.
    // A true oversized transient must remain an actionable resource limit.
    const il = Buffer.alloc(270_001);
    il[il.length - 1] = 0x2a;
    const header = Buffer.alloc(12);
    header.writeUInt16LE(0x3003, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([header, il]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.coverage).toMatchObject({
      state: "unavailable",
      issues: [{ code: "resource-limit", scope: "metadata.representation" }],
    });
    // Report the originating IL coordinate, not a generic decoding error.
    expect(result.coverage.issues[0]?.offset).toBeGreaterThan(0);
    expect(result.types).toEqual([]);
    expect(result.methods).toEqual([]);
  });

  it("charges decoded output rather than accumulated decoding bounds", () => {
    // Each bound fits alone, but 256 bytes per IL and signature byte together
    // exceed the 64 MiB budget although the retained members are small.
    const il = Buffer.concat([Buffer.alloc(200_000), Buffer.from([0x2a])]);
    const header = Buffer.alloc(12);
    header.writeUInt16LE(0x3003, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([header, il]),
      methodSignature: Buffer.concat([
        Buffer.from([0x00, 0x00, 0x01]),
        Buffer.alloc(80_000),
      ]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.coverage.state).not.toBe("unavailable");
    expect(result.methods[0]?.body).toMatchObject({
      status: "present",
      il_size: il.length,
      opcode_counts: { nop: 200_000, ret: 1 },
    });
  });

  it("bounds a method's IL and exception sections together", () => {
    // Each bound fits alone; both stay live while one method is decoded.
    const il = Buffer.concat([Buffer.alloc(159_999), Buffer.from([0x2a])]);
    const header = Buffer.alloc(12);
    header.writeUInt16LE(0x300b, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
    const clauses = 110_000;
    const section = Buffer.alloc(4 + clauses * 24);
    section.writeUInt32LE(0x41 | ((4 + clauses * 24) << 8), 0);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([header, il, section]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.coverage).toMatchObject({
      state: "unavailable",
      issues: [{ code: "resource-limit" }],
    });
  });
});

describe("managed derived edges", () => {
  it("admits call edges before the derived graph exceeds the budget", () => {
    const anchor = {
      il_offset: 0,
      opcode: "call",
      operand_kind: "method",
      operand: "0x0a000001",
    };
    const method = {
      token: "0x06000001",
      declaring_type: "T".repeat(2000),
      name: "m",
      body: { anchors: Array.from({ length: 40_000 }, () => anchor) },
    } as unknown as ManagedMethod;

    expect(() =>
      edges(
        [method],
        new Map(),
        new Map(),
        new Map(),
        new ManagedDecodeBudget(),
      ),
    ).toThrow(ManagedReaderFailure);
  });
});

describe("managed derived caller names", () => {
  it("admits a caller name before building it", () => {
    let built = false;
    // A string-like type name records whether the caller was interpolated.
    const declaringType = {
      length: 70 * 1024 * 1024,
      charCodeAt: () => 0x54,
      toString: () => {
        built = true;
        return "T";
      },
    } as unknown as string;
    const method = {
      token: "0x06000001",
      declaring_type: declaringType,
      name: "m",
      body: {
        anchors: [
          {
            il_offset: 0,
            opcode: "call",
            operand_kind: "method",
            operand: "0x0a000001",
          },
        ],
      },
    } as unknown as ManagedMethod;

    expect(() =>
      edges(
        [method],
        new Map(),
        new Map(),
        new Map(),
        new ManagedDecodeBudget(),
      ),
    ).toThrow(ManagedReaderFailure);
    expect(built).toBe(false);
  });
});

describe("managed member reference bounds", () => {
  it("retains members and reports an out-of-range TypeDef coded index as partial", () => {
    const bytes = buildManagedPeFixture({ extendsRaw: 12 });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.types[0]).toMatchObject({
      token: "0x02000001",
      extends_token: null,
    });
    expect(result.fields).toHaveLength(1);
    expect(result.methods).toHaveLength(1);
    expect(result.metadata.status).toBe("partial");
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        {
          code: "invalid-row",
          scope: "metadata.TypeDef:0x02000001",
          detail: expect.stringContaining(
            "TypeDef Extends coded index 0xc is invalid: coded index selects row 3 in table 2, which has 1 rows",
          ),
        },
      ],
    });
    expect(result.coverage.issues[0]?.offset).toBe(
      (result.types[0]?.row_offset ?? 0) + 8,
    );
  });

  it("retains a MemberRef with an out-of-range parent as an unknown partial reference", () => {
    const bytes = buildManagedPeFixture({ memberRefParentRaw: 40 });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.member_refs[0]).toMatchObject({
      token: "0x0a000001",
      parent_token: null,
      name: ".ctor",
    });
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        {
          code: "invalid-row",
          scope: "metadata.MemberRef:0x0a000001",
          detail: expect.stringContaining(
            "MemberRef parent coded index 0x28 is invalid: coded index selects row 5 in table 2, which has 1 rows",
          ),
        },
      ],
    });
    expect(result.coverage.issues[0]?.offset).toBe(
      result.member_refs[0]?.row_offset,
    );
  });

  it("reports a null required MemberRef parent without dropping the reference", () => {
    const bytes = buildManagedPeFixture({ memberRefParentRaw: 0 });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.member_refs[0]).toMatchObject({
      token: "0x0a000001",
      parent_token: null,
    });
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          code: "invalid-row",
          detail:
            "MemberRef parent coded index 0x0 is null, but the Class column must reference a row",
        }),
      ],
    });
  });

  it("decodes deeply nested supported pointer signatures without recursion", () => {
    const depth = 8_000;
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.concat([
        Buffer.from([0x06]),
        Buffer.alloc(depth, 0x0f),
        Buffer.from([0x08]),
      ]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.fields[0]?.signature).toMatchObject({
      kind: "field",
      parse_status: "decoded",
      field_type: `${"i4"}${"*".repeat(depth)}`,
      issue: null,
    });
    expect(result.methods[0]?.body.status).toBe("present");
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });
});

it.each([
  Buffer.alloc(0),
  Buffer.from([0]),
  Buffer.from([0, 0, 0x12]),
  Buffer.from([0x10, 0x80]),
  Buffer.from([0, 0xe0]),
])(
  "marks incomplete or reserved method signatures malformed: %j",
  (methodSignature) => {
    const bytes = buildManagedPeFixture({ methodSignature });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.methods[0]?.signature).toMatchObject({
      parse_status: "malformed",
      kind: "unknown",
    });
  },
);

it("decodes generic instantiation member signatures as complete coverage", () => {
  // System.Runtime.Caching 0x06000001: instance void (Dictionary<string, object>)
  // shape, with TypeRef/TypeSpec coded tokens kept as encoded.
  const bytes = buildManagedPeFixture({
    methodSignature: Buffer.from([
      0x00, 0x01, 0x01, 0x15, 0x12, 0x71, 0x01, 0x0e,
    ]),
    fieldSignature: Buffer.from([
      0x06, 0x15, 0x11, 0x0a, 0x02, 0x13, 0x00, 0x1e, 0x01,
    ]),
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );

  expect(result.methods[0]?.signature).toMatchObject({
    parse_status: "decoded",
    return_type: "void",
    parameter_types: ["class:113<string>"],
    issue: null,
  });
  expect(result.fields[0]?.signature).toMatchObject({
    parse_status: "decoded",
    field_type: "valuetype:10<var:0,mvar:1>",
  });
  expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
});

it.each([
  ["single-dimension general array", [0x14, 0x08, 0x01, 0x00, 0x00], "i4[...]"],
  [
    "sized array with signed lower bounds",
    [0x14, 0x08, 0x02, 0x02, 0x04, 0x03, 0x02, 0x02, 0x7f],
    "i4[1...4,-1...1]",
  ],
  [
    "partially bounded array",
    [0x14, 0x0e, 0x03, 0x01, 0x05, 0x00],
    "string[5,,]",
  ],
  [
    "function pointer",
    [0x1b, 0x00, 0x02, 0x08, 0x0e, 0x1c],
    "fnptr[default](string,object)->i4",
  ],
  ["required modifier", [0x1f, 0x09, 0x08], "i4 modreq:9"],
  [
    "optional modifier under a pointer",
    [0x0f, 0x20, 0x0d, 0x08],
    "i4 modopt:13*",
  ],
  [
    "adjacent modifiers in source order",
    [0x1f, 0x05, 0x20, 0x09, 0x08],
    "i4 modreq:5 modopt:9",
  ],
  [
    "modifier runs separated by a pointer",
    [0x1f, 0x05, 0x0f, 0x20, 0x09, 0x08],
    "i4 modopt:9* modreq:5",
  ],
  [
    "unmanaged cdecl function pointer",
    [0x1b, 0x01, 0x01, 0x01, 0x18],
    "fnptr[c](native-int)->void",
  ],
  [
    "array of generic instantiations",
    [0x1d, 0x15, 0x12, 0x05, 0x01, 0x14, 0x08, 0x01, 0x01, 0x03, 0x00],
    "class:5<i4[3]>[]",
  ],
])("decodes a %s field signature", (_name, type, expected) => {
  expect(signature(Buffer.from([0x06, ...type]))).toMatchObject({
    kind: "field",
    parse_status: "decoded",
    field_type: expected,
    issue: null,
  });
});

it.each([
  ["generic instantiation without arguments", [0x15, 0x12, 0x05, 0x00]],
  ["generic instantiation of a primitive", [0x15, 0x08, 0x05, 0x01, 0x08]],
  ["zero-rank array", [0x14, 0x08, 0x00, 0x00, 0x00]],
  [
    "array with more sizes than dimensions",
    [0x14, 0x08, 0x01, 0x02, 0x01, 0x01, 0x00],
  ],
  ["truncated generic argument list", [0x15, 0x12, 0x05, 0x02, 0x08]],
  ["truncated function pointer", [0x1b, 0x00, 0x01, 0x08]],
  ["function pointer with a field header", [0x1b, 0x06, 0x00, 0x01]],
  ["function pointer with a reserved flag", [0x1b, 0x80, 0x00, 0x01]],
  [
    "function pointer with explicit-this but no has-this",
    [0x1b, 0x40, 0x00, 0x01],
  ],
  ["typed reference field", [0x16]],
  ["modified typed reference field", [0x20, 0x09, 0x16]],
  ["typed reference generic argument", [0x15, 0x12, 0x05, 0x01, 0x16]],
  ["typed reference array element", [0x1d, 0x16]],
  ["by-reference generic argument", [0x15, 0x12, 0x05, 0x01, 0x10, 0x08]],
  ["void generic argument", [0x15, 0x12, 0x05, 0x01, 0x01]],
  ["void function pointer parameter", [0x1b, 0x00, 0x01, 0x01, 0x01]],
  ["by-reference pointee", [0x0f, 0x10, 0x08]],
  ["nested by-reference", [0x10, 0x10, 0x08]],
  ["void field", [0x01]],
  ["void array element", [0x1d, 0x01]],
])("reports a %s as malformed", (_name, type) => {
  expect(signature(Buffer.from([0x06, ...type]))).toMatchObject({
    kind: "unknown",
    parse_status: "malformed",
  });
});

it("rejects array ranks beyond the CLR limit before rendering dimensions", () => {
  expect(
    signature(
      Buffer.from([0x06, 0x14, 0x08, 0xdf, 0xff, 0xff, 0xff, 0x00, 0x00]),
    ),
  ).toMatchObject({
    parse_status: "unsupported",
    issue: "array rank 536870911 exceeds the 32 dimensions the CLR supports",
  });
  expect(
    signature(Buffer.from([0x06, 0x14, 0x08, 0x20, 0x00, 0x00])),
  ).toMatchObject({
    parse_status: "decoded",
    field_type: `i4[${",".repeat(31)}]`,
  });
});

it("decodes typed references in parameter and return positions", () => {
  expect(
    signature(Buffer.from([0x00, 0x02, 0x16, 0x20, 0x09, 0x16, 0x08])),
  ).toMatchObject({
    kind: "method",
    parse_status: "decoded",
    return_type: "typedbyref",
    parameter_types: ["typedbyref modopt:9", "i4"],
  });
  expect(
    signature(Buffer.from([0x06, 0x1b, 0x20, 0x01, 0x01, 0x16])),
  ).toMatchObject({
    parse_status: "decoded",
    field_type: "fnptr[default has-this](typedbyref)->void",
  });
});

it.each([
  ["by-reference field", [0x06, 0x10, 0x08], { field_type: "i4&" }],
  ["void pointer field", [0x06, 0x0f, 0x01], { field_type: "void*" }],
  [
    "by-reference function pointer return and parameter",
    [0x06, 0x1b, 0x00, 0x01, 0x10, 0x08, 0x10, 0x0e],
    { field_type: "fnptr[default](string&)->i4&" },
  ],
  [
    "by-reference method return and parameter",
    [0x00, 0x01, 0x10, 0x08, 0x10, 0x15, 0x12, 0x05, 0x01, 0x0f, 0x01],
    { return_type: "i4&", parameter_types: ["class:5<void*>&"] },
  ],
])("decodes a %s in its grammar position", (_name, blob, expected) => {
  expect(signature(Buffer.from(blob))).toMatchObject({
    parse_status: "decoded",
    ...expected,
  });
});

it("keeps element types that member signatures do not assign unsupported", () => {
  expect(signature(Buffer.from([0x06, 0x45, 0x08]))).toMatchObject({
    parse_status: "unsupported",
    issue: "unsupported element type 0x45",
  });
});

it("decodes deeply nested generic instantiations without recursion", () => {
  const depth = 4_000;
  const decoded = signature(
    Buffer.concat([
      Buffer.from([0x06]),
      Buffer.from(
        Array.from({ length: depth }, () => [0x15, 0x12, 0x05, 0x01]).flat(),
      ),
      Buffer.from([0x08]),
    ]),
  );

  expect(decoded).toMatchObject({
    parse_status: "decoded",
    field_type: `${"class:5<".repeat(depth)}i4${">".repeat(depth)}`,
  });
});

it("preserves leading U+FEFF as metadata name content", () => {
  const bytes = buildManagedPeFixture({
    typeNamespace: "\uFEFFFixture",
    typeName: "\uFEFFProgram",
    methodName: "\uFEFFMain",
    fieldName: "\uFEFFcounter",
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.types[0]?.full_name).toBe("\uFEFFFixture.\uFEFFProgram");
  expect(result.methods[0]?.name).toBe("\uFEFFMain");
  expect(result.fields[0]?.name).toBe("\uFEFFcounter");
  expect(result.call_edges[0]?.caller).toBe(
    "\uFEFFFixture.\uFEFFProgram.\uFEFFMain",
  );
});

it.each([
  { implFlags: 1, flags: 0, label: "native" },
  { implFlags: 3, flags: 0, label: "runtime" },
  { implFlags: 4, flags: 0, label: "unmanaged" },
  { implFlags: 0, flags: 0x2000, label: "pinvoke" },
])(
  "does not interpret $label implementations as CIL",
  ({ implFlags, flags }) => {
    const bytes = buildManagedPeFixture();
    const original = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const row = original.methods[0]?.row_offset;
    expect(row).toBeDefined();
    if (row === undefined) return;
    bytes.writeUInt16LE(implFlags, row + 4);
    bytes.writeUInt16LE(bytes.readUInt16LE(row + 6) | flags, row + 6);
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.methods[0]?.body).toMatchObject({
      status: "partial",
      header_format: "unknown",
      rva: original.methods[0]?.rva,
      il_sha256: null,
      normalized_il_sha256: null,
      anchors: [],
    });
    expect(result.methods[0]?.body.issue).toMatch(/CIL/u);
    expect(result.coverage.state).toBe("partial");
    expect(result.call_edges).toEqual([]);
    expect(result.field_accesses).toEqual([]);
  },
);

it.each([
  { facet: "fields", nameOffset: 2 },
  { facet: "methods", nameOffset: 8 },
  { facet: "member_refs", nameOffset: 2 },
  { facet: "types", nameOffset: 4 },
] as const)(
  "preserves independent metadata when a $facet name is unreadable",
  ({ facet, nameOffset }) => {
    const bytes = buildManagedPeFixture();
    const original = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    const row = original[facet][0]?.row_offset;
    if (row === undefined) throw new Error(`Fixture must contain ${facet}`);
    bytes.writeUInt16LE(0xffff, row + nameOffset);
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.module?.mvid).toBe(original.module?.mvid);
    expect(result.metadata.status).toBe("partial");
    expect(result[facet]).toEqual([]);
    for (const remaining of [
      "fields",
      "methods",
      "member_refs",
      "types",
    ] as const)
      if (remaining !== facet)
        expect(result[remaining]).toHaveLength(original[remaining].length);
    expect(result.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({
          code: "invalid-heap-index",
          scope: "metadata.#Strings",
        }),
      ],
    });
    if (facet === "types") {
      expect(result.fields[0]).toMatchObject({
        declaring_type_token: "0x02000001",
        declaring_type: null,
      });
      expect(result.methods[0]).toMatchObject({
        declaring_type_token: "0x02000001",
        declaring_type: null,
      });
    }
  },
);

describe("managed member type selection", () => {
  const bytes = buildManagedPeFixture();
  const target = managedPeFixtureTarget(bytes);
  const everything = inspectManagedMembersBytes(bytes, target);

  it("reports no selection when every type is inspected", () => {
    expect(everything.selection).toBeNull();
  });

  it("decodes the selected type's members and reports unmatched names", () => {
    const result = inspectManagedMembersBytes(bytes, target, {
      typeNames: ["Fixture.Program", "Missing.Type"],
    });

    expect(result.selection).toEqual({
      type_names: ["Fixture.Program", "Missing.Type"],
      unmatched_type_names: ["Missing.Type"],
    });
    expect(result.types).toEqual(everything.types);
    expect(result.fields).toEqual(everything.fields);
    expect(result.methods).toEqual(everything.methods);
    expect(result.call_edges).toEqual(everything.call_edges);
    expect(result.field_accesses).toEqual(everything.field_accesses);
    expect(result.coverage).toEqual(everything.coverage);
    expect(result.limitations).toContain(
      "Types, fields, methods, call edges, and field accesses cover only the selected declaring types; coverage describes that selection. Edge targets outside it keep their names but are not described.",
    );
  });

  it("does not treat a name as absent when a TypeDef name is unreadable", () => {
    const corrupt = Buffer.from(bytes);
    const row = everything.types[0]?.row_offset ?? 0;
    // Point the TypeDef Name past the #Strings heap.
    corrupt.writeUInt16LE(0xffff, row + 4);
    const result = inspectManagedMembersBytes(
      corrupt,
      managedPeFixtureTarget(corrupt),
      { typeNames: ["Fixture.Program"] },
    );

    expect(result.selection?.unmatched_type_names).toEqual(["Fixture.Program"]);
    expect(result.coverage.state).toBe("partial");
    expect(result.limitations).toContain(
      "1 TypeDef name(s) could not be read; a name in selection.unmatched_type_names may belong to one of them, so its absence is not observed.",
    );
  });

  it("omits members of unselected types without dropping member references", () => {
    const result = inspectManagedMembersBytes(bytes, target, {
      typeNames: ["Missing.Type"],
    });

    expect(result.selection).toEqual({
      type_names: ["Missing.Type"],
      unmatched_type_names: ["Missing.Type"],
    });
    expect(result.types).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.methods).toEqual([]);
    expect(result.call_edges).toEqual([]);
    expect(result.field_accesses).toEqual([]);
    expect(result.member_refs).toEqual(everything.member_refs);
  });
});
