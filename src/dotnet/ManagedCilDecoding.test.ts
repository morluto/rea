import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const managedBodyWithSections = (...sections: Buffer[]) => {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(0x300b, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(1, 4);
  const bytes = buildManagedPeFixture({
    ilBody: Buffer.concat([
      header,
      Buffer.from([0x2a]),
      Buffer.alloc(3),
      ...sections,
    ]),
  });
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes))
    .methods[0]?.body;
};

describe("managed CIL decoding", () => {
  it("reads fat method header size from the full flags-and-size word", () => {
    const il = Buffer.from([
      0x21, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x26, 0x22, 0x00,
      0x00, 0x80, 0x3f, 0x26, 0x23, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0,
      0x3f, 0x26, 0xfe, 0x06, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a,
    ]);
    const header = Buffer.alloc(12);
    header.writeUInt16LE(0x3013, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(il.length, 4);
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.concat([header, il]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.methods[0]?.body).toMatchObject({
      status: "present",
      header_format: "fat",
      il_size: il.length,
      il_sha256: createHash("sha256").update(il).digest("hex"),
      opcode_counts: {
        "ldc.i8": 1,
        pop: 4,
        "ldc.r4": 1,
        "ldc.r8": 1,
        ldftn: 1,
        ret: 1,
      },
      issue: null,
    });
  });

  it("does not normalize reserved CIL opcodes as operand-free instructions", () => {
    const bytes = buildManagedPeFixture({
      ilBody: Buffer.from([0x0a, 0x24, 0x2a]),
    });
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(result.methods[0]?.body).toMatchObject({
      status: "malformed",
      il_size: 2,
      normalized_il_sha256: null,
      decoded_instruction_count: 0,
      issue: "Unsupported CIL opcode 0x24 at IL offset 0",
    });
  });

  it("keeps the documented decoded-CIL v1 golden vector stable", () => {
    const il = Buffer.from([0x00, 0x2a]);
    const tinyBytes = buildManagedPeFixture({
      ilBody: Buffer.from([0x0a, ...il]),
    });
    const fatHeader = Buffer.alloc(12);
    fatHeader.writeUInt16LE(0x3013, 0);
    fatHeader.writeUInt16LE(32, 2);
    fatHeader.writeUInt32LE(il.length, 4);
    fatHeader.writeUInt32LE(0x1100_0001, 8);
    const fatBytes = buildManagedPeFixture({
      ilBody: Buffer.concat([fatHeader, il]),
    });
    const tiny = inspectManagedMembersBytes(
      tinyBytes,
      managedPeFixtureTarget(tinyBytes),
    );
    const fat = inspectManagedMembersBytes(
      fatBytes,
      managedPeFixtureTarget(fatBytes),
    );

    expect(tiny.methods[0]?.body).toMatchObject({
      status: "present",
      header_format: "tiny",
      max_stack: 8,
      init_locals: false,
      local_var_sig_token: null,
      il_size: 2,
      il_sha256: createHash("sha256").update(il).digest("hex"),
      normalized_il_sha256:
        "5e5fad7741cb44bca3a4f045546b7449990da343f612f5f34c0ca30e9eee0636",
      opcode_counts: { nop: 1, ret: 1 },
      exception_regions: [],
    });
    expect(fat.methods[0]?.body).toMatchObject({
      header_format: "fat",
      max_stack: 32,
      init_locals: true,
      local_var_sig_token: "0x11000001",
      il_sha256: tiny.methods[0]?.body.il_sha256,
      normalized_il_sha256: tiny.methods[0]?.body.normalized_il_sha256,
    });
  });
});

describe("managed exception section decoding", () => {
  it("marks an exception section with a partial clause as malformed", () => {
    const section = Buffer.alloc(17);
    section[0] = 0x01;
    section[1] = section.length;

    expect(managedBodyWithSections(section)).toMatchObject({
      status: "malformed",
      exception_regions: [],
      issue: "Exception section size does not contain whole clauses",
    });
  });

  it("reads every chained exception section", () => {
    const first = Buffer.alloc(16);
    first[0] = 0x81;
    first[1] = first.length;
    const second = Buffer.alloc(16);
    second[0] = 0x01;
    second[1] = second.length;
    expect(managedBodyWithSections(first, second)).toMatchObject({
      status: "present",
      issue: null,
      exception_regions: [
        { flags: 0, try_offset: 0, try_length: 0, handler_offset: 0 },
        { flags: 0, try_offset: 0, try_length: 0, handler_offset: 0 },
      ],
    });
  });

  it("reports malformed data in a chained section", () => {
    const first = Buffer.alloc(16);
    first[0] = 0x81;
    first[1] = first.length;
    const second = Buffer.from([0x02, 0x04, 0x00, 0x00]);
    expect(managedBodyWithSections(first, second)).toMatchObject({
      status: "malformed",
      exception_regions: [],
      issue: "Unsupported method data section kind 2",
    });
  });

  it.each([
    {
      name: "unsupported section kind",
      section: Buffer.from([0x02, 0x04, 0x00, 0x00]),
      issue: "Unsupported method data section kind 2",
    },
    {
      name: "section size outside artifact",
      section: Buffer.from([0x41, 0xff, 0xff, 0xff]),
      issue: "Exception section size leaves artifact",
    },
  ])("rejects $name", ({ section, issue }) => {
    expect(managedBodyWithSections(section)).toMatchObject({
      status: "malformed",
      exception_regions: [],
      issue,
    });
  });
});
