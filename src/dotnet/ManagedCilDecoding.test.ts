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

const managedBodyWithRegion = ({
  il,
  flags = 0,
  tryOffset = 0,
  tryLength = 1,
  handlerOffset,
  handlerLength = 1,
  extra = 0x0200_0001,
}: {
  readonly il: Buffer;
  readonly flags?: number;
  readonly tryOffset?: number;
  readonly tryLength?: number;
  readonly handlerOffset: number;
  readonly handlerLength?: number;
  readonly extra?: number;
}) => {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(0x300b, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(il.length, 4);
  const section = Buffer.alloc(16);
  section[0] = 0x01;
  section[1] = section.length;
  section.writeUInt16LE(flags, 4);
  section.writeUInt16LE(tryOffset, 6);
  section[8] = tryLength;
  section.writeUInt16LE(handlerOffset, 9);
  section[11] = handlerLength;
  section.writeUInt32LE(extra, 12);
  const bytes = buildManagedPeFixture({
    ilBody: Buffer.concat([
      header,
      il,
      Buffer.alloc((4 - (il.length % 4)) % 4),
      section,
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

  it("does not decode overlay bytes after the method's file-backed PE section", () => {
    const original = buildManagedPeFixture();
    const bytes = Buffer.concat([original, Buffer.from([0x2a])]);
    const parsed = inspectManagedMembersBytes(
      original,
      managedPeFixtureTarget(original),
    );
    const methodRow = parsed.methods[0]?.row_offset;
    expect(methodRow).toBeDefined();
    if (methodRow === undefined) return;
    bytes.writeUInt32LE(0x2dff, methodRow);
    bytes[0xfff] = 0x06;
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.methods[0]?.body).toMatchObject({
      status: "malformed",
      header_format: "unknown",
      issue: "Method body leaves file-backed PE section data",
      anchors: [],
    });
  });

  it("does not decode overlay exception sections after the file-backed PE section", () => {
    const original = buildManagedPeFixture();
    const overlay = Buffer.from([0x01, 0x04, 0x00, 0x00]);
    const bytes = Buffer.concat([original, overlay]);
    const parsed = inspectManagedMembersBytes(
      original,
      managedPeFixtureTarget(original),
    );
    const methodRow = parsed.methods[0]?.row_offset;
    expect(methodRow).toBeDefined();
    if (methodRow === undefined) return;
    const body = Buffer.alloc(16);
    body.writeUInt16LE(0x301b, 0);
    body.writeUInt16LE(8, 2);
    body.writeUInt32LE(1, 4);
    body[12] = 0x2a;
    body.copy(bytes, 0xff0);
    bytes.writeUInt32LE(0x2df0, methodRow);
    overlay.copy(bytes, 0x1000);
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(result.methods[0]?.body).toMatchObject({
      status: "malformed",
      issue: "Exception section header leaves artifact",
      exception_regions: [],
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

describe("managed exception region bounds", () => {
  it("marks out-of-method ranges malformed and preserves the raw EH clause", () => {
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x2a]),
        tryOffset: 0,
        tryLength: 2,
        handlerOffset: 0,
      }),
    ).toMatchObject({
      status: "malformed",
      il_size: 1,
      exception_regions: [
        {
          flags: 0,
          try_offset: 0,
          try_length: 2,
          handler_offset: 0,
          handler_length: 1,
          class_token: "0x02000001",
        },
      ],
      issue: "Exception clause try range leaves the method IL body",
    });
  });

  it("uses half-open method bounds and permits zero-length ranges", () => {
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x00, 0x00, 0x2a]),
        tryOffset: 0,
        tryLength: 1,
        handlerOffset: 1,
        handlerLength: 2,
      }),
    ).toMatchObject({ status: "present", il_size: 3, issue: null });
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x2a]),
        tryOffset: 0,
        tryLength: 0,
        handlerOffset: 0,
        handlerLength: 0,
      }),
    ).toMatchObject({ status: "present", il_size: 1, issue: null });
  });

  it("marks reserved clause flags malformed without dropping its bytes", () => {
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x00, 0x2a]),
        flags: 8,
        tryLength: 1,
        handlerOffset: 1,
      }),
    ).toMatchObject({
      status: "malformed",
      exception_regions: [expect.objectContaining({ flags: 8 })],
      issue: "Exception clause has unsupported flags 0x8",
    });
  });

  it.each([2, 4])(
    "accepts the defined finally/fault clause flag %s",
    (flags) => {
      expect(
        managedBodyWithRegion({
          il: Buffer.from([0x00, 0x00, 0x2a]),
          flags,
          tryOffset: 0,
          tryLength: 1,
          handlerOffset: 1,
          handlerLength: 2,
        }),
      ).toMatchObject({ status: "present", issue: null });
    },
  );

  it("validates filter ordering", () => {
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x00, 0x00, 0xfe, 0x11, 0x2a]),
        flags: 1,
        tryOffset: 0,
        tryLength: 1,
        handlerOffset: 4,
        extra: 1,
      }),
    ).toMatchObject({ status: "present", il_size: 5, issue: null });
    expect(
      managedBodyWithRegion({
        il: Buffer.from([0x00, 0x00, 0x2a]),
        flags: 1,
        tryOffset: 0,
        tryLength: 1,
        handlerOffset: 1,
        extra: 1,
      }),
    ).toMatchObject({
      status: "malformed",
      issue:
        "Exception clause filter must start before its handler within the method IL body",
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
