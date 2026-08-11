import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
  MANAGED_MEMBER_FIXTURE_LIMITS,
} from "./ManagedPe.fixture.js";

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
      MANAGED_MEMBER_FIXTURE_LIMITS,
    );

    expect(result.methods.items[0]?.body).toMatchObject({
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
      MANAGED_MEMBER_FIXTURE_LIMITS,
    );

    expect(result.methods.items[0]?.body).toMatchObject({
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
      MANAGED_MEMBER_FIXTURE_LIMITS,
    );
    const fat = inspectManagedMembersBytes(
      fatBytes,
      managedPeFixtureTarget(fatBytes),
      MANAGED_MEMBER_FIXTURE_LIMITS,
    );

    expect(tiny.methods.items[0]?.body).toMatchObject({
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
    expect(fat.methods.items[0]?.body).toMatchObject({
      header_format: "fat",
      max_stack: 32,
      init_locals: true,
      local_var_sig_token: "0x11000001",
      il_sha256: tiny.methods.items[0]?.body.il_sha256,
      normalized_il_sha256: tiny.methods.items[0]?.body.normalized_il_sha256,
    });
  });
});
