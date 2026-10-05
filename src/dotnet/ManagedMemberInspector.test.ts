import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

describe("managed member inspection", () => {
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

it("keeps an admitted but unimplemented element type unsupported", () => {
  // ECMA-335 ELEMENT_TYPE_ARRAY is valid, but multidimensional arrays are not decoded here.
  const bytes = buildManagedPeFixture({
    fieldSignature: Buffer.from([6, 0x14, 8, 1, 0, 0]),
  });
  const result = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(result.fields[0]?.signature).toMatchObject({
    parse_status: "unsupported",
    issue: "unsupported element type 0x14",
  });
});
