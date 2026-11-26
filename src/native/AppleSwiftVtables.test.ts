import {
  swiftFixtureEvidence,
  swiftFixtureLocation,
} from "./AppleSwiftReaders.fixture.js";
import { describe, expect, it } from "vitest";

import { objcSwiftMetadataSchema } from "../domain/native/objcSwiftMetadata.js";
import { pushDispatchCoverage } from "./AppleDispatchCoverage.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.fixture.js";
import { createSwiftClassVtableDecoder } from "./AppleSwiftVtables.js";
import {
  decodeSwiftNominalTypes,
  createSwiftContextReader,
  type SwiftNominalReaders,
} from "./AppleSwiftNominalTypes.js";
import { decodeSwiftDispatchFacets } from "./AppleSwiftDispatchFacets.js";
import type {
  DispatchRecordBudget,
  SwiftDispatchReaders,
} from "./AppleSwiftDispatchFacets.js";
import { issue } from "../domain/apple/appleDispatchDecodeFacts.js";

it("propagates unexpected conformance reader failures", () => {
  const failure = new Error("conformance reader invariant failed");
  expect(() =>
    decodeSwiftDispatchFacets({
      sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
      segments: [],
      readers: {} as SwiftDispatchReaders,
      relative: () => {
        throw failure;
      },
      budget: {
        truncated: false,
        isFull: () => false,
        markTruncated: () => {},
        admit: () => true,
      },
      result: objcSwiftMetadataSchema.parse({ db_save_result: null }),
    }),
  ).toThrow(failure);
});

it("propagates unexpected vtable reader failures", () => {
  const failure = new Error("vtable reader invariant failed");
  const vtables = createSwiftClassVtableDecoder({
    result: objcSwiftMetadataSchema.parse({ db_save_result: null }),
    readers: {
      u32: () => {
        throw failure;
      },
      relative: () => ({ kind: "null" }),
      location: () => ({ address: null, file_offset: null }),
      evidence: () => [],
      executable: () => false,
      admit: () => true,
    },
  });
  expect(() =>
    vtables.visitor.descriptor({
      record: 0x100n,
      descriptor: 0x200n,
      flags: 0x80000010,
      name: "Widget",
      context: {
        module: "Test",
        path: "Widget",
        depth: 2,
        anonymous: false,
        reason: null,
        walkLimited: false,
      },
    }),
  ).toThrow(failure);
});

it.each([
  [20_001, "Swift vtable count or offset exceeds declared metadata bounds"],
  [20_002, "Swift vtable count exceeds 20000"],
] as const)(
  "distinguishes vtable metadata bounds from the slot limit with %i metadata words",
  (positiveWords, reason) => {
    const base = 0x100000000n;
    const descriptor = 0x300;
    const slotCount = 20_001;
    // Both controls have room for every serialized slot; only the class's
    // declared metadata extent differs.
    const bytes = Buffer.alloc(descriptor + 52 + slotCount * 8);
    const u32 = (at: number, value: number) => bytes.writeUInt32LE(value, at);
    u32(0, 0xfeedfacf);
    u32(4, 0x0100000c);
    u32(12, 2);
    u32(16, 1);
    u32(20, 152);
    u32(32, 0x19);
    u32(36, 152);
    bytes.write("__TEXT", 40);
    bytes.writeBigUInt64LE(base, 56);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 64);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 80);
    u32(88, 5);
    u32(92, 5);
    u32(96, 1);
    bytes.write("__swift5_types", 104);
    bytes.write("__TEXT", 120);
    bytes.writeBigUInt64LE(base + 0x200n, 136);
    bytes.writeBigUInt64LE(4n, 144);
    u32(152, 0x200);
    bytes.writeInt32LE(descriptor - 0x200, 0x200);
    bytes.writeInt32LE(0x260 - (0x240 + 8), 0x240 + 8);
    bytes.write("Fixture\0", 0x260);
    bytes.write("Widget\0", 0x280);
    u32(descriptor, 0x80000010);
    bytes.writeInt32LE(0x240 - (descriptor + 4), descriptor + 4);
    bytes.writeInt32LE(0x280 - (descriptor + 8), descriptor + 8);
    u32(descriptor + 28, positiveWords);
    u32(descriptor + 44, 1);
    u32(descriptor + 48, slotCount);

    const report = decodeAppleDispatchMetadata(bytes, 100, {
      path: "/fixture/widget",
      sha256: "a".repeat(64),
    });
    expect(report.swift_decls).toContainEqual(
      expect.objectContaining({ name: "Widget", module: "Fixture" }),
    );
    expect(report.swift_dispatch_slots).toEqual([]);
    expect(report.coverage).toContainEqual(
      expect.objectContaining({
        facet: "swift_class_vtable_descriptors",
        status: "partial",
        examined: 0,
        decoded: 0,
        reason: expect.stringContaining(reason),
      }),
    );
  },
);

it("preserves unsupported type-metadata tag reasons instead of reporting null", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const vtables = createSwiftClassVtableDecoder({
    result,
    readers: {
      u32: () => 0,
      relative: () => ({ kind: "null" }),
      location: swiftFixtureLocation,
      evidence: () => [],
      executable: () => false,
      admit: () => true,
    },
  });
  const nominalReaders: SwiftNominalReaders = {
    u32: () => 0,
    relative: () => ({
      kind: "unknown",
      reason: "Unsupported Swift type metadata record tag 2",
    }),
    string: () => "unused",
    location: swiftFixtureLocation,
    evidence: () => [],
    executable: () => false,
    admit: () => true,
  };
  const nominal = decodeSwiftNominalTypes({
    entries: [{ address: 0x100n, section: "__swift5_types" }],
    result,
    visitor: vtables.visitor,
    readers: nominalReaders,
    contextReader: createSwiftContextReader(nominalReaders),
  });
  const facts = vtables.facts();

  expect(nominal.issues).toMatchObject([
    {
      code: "type_decode_failed",
      message: "Unsupported Swift type metadata record tag 2",
    },
  ]);
  expect(facts.issues).toMatchObject([
    {
      code: "vtable_decode_failed",
      message: "Unsupported Swift type metadata record tag 2",
      location: "0x100",
    },
  ]);
  expect(facts.issues[0]?.message).not.toContain("Null Swift");
});

it("preserves a required conformance pointer's unknown reason", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const facts = decodeSwiftDispatchFacets({
    sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
    segments: [],
    readers: {
      u32: () => 0,
      i32: () => 0,
      pointer: () => 0n,
      resolvePointer: () => ({ kind: "raw", target: 0n }),
      string: () => "unused",
      location: swiftFixtureLocation,
      targetLocation: swiftFixtureLocation,
      evidence: () => [],
      offset: (address) => Number(address),
    },
    relative: () => ({
      kind: "unknown",
      reason: "Unsupported Swift conformance record tag 3",
    }),
    budget: {
      truncated: false,
      isFull: () => false,
      markTruncated: () => {},
      admit: () => true,
    },
    result,
  });

  expect(facts.issues).toMatchObject([
    {
      code: "conformance_decode_failed",
      message: "Unsupported Swift conformance record tag 3",
    },
  ]);
});

it("counts examined slots and reports an unresolved async slot", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const values = new Map<bigint, number>([
    [0x200n, 0x80000010], // class descriptor with a vtable
    [0x22cn, 0], // table offset
    [0x230n, 2], // slot count
    [0x21cn, 2], // descriptor positive words
    [0x234n, 0x40], // async method flag
  ]);
  const vtables = createSwiftClassVtableDecoder({
    result,
    readers: {
      u32: (address) => values.get(address) ?? 0,
      relative: () => ({ kind: "target", target: 0x400n }),
      location: swiftFixtureLocation,
      evidence: swiftFixtureEvidence,
      executable: (address) => address === 0x400n,
      admit: () => true,
    },
  });
  vtables.visitor.descriptor({
    record: 0x100n,
    descriptor: 0x200n,
    flags: 0x80000010,
    name: "Widget",
    context: {
      module: "Test",
      path: "Widget",
      depth: 2,
      anonymous: false,
      reason: null,
      walkLimited: false,
    },
  });
  const facts = vtables.facts();

  expect(result.swift_dispatch_slots[0]?.decode.status).toBe("partial");
  expect(result.swift_dispatch_slots[1]?.decode.status).toBe("decoded");
  expect(facts).toMatchObject({
    facet: "swift_class_vtable_descriptors",
    examined: 2,
    decoded: 1,
    exhaustive: false,
    issues: [{ code: "vtable_implementation_unresolved", location: "0x234" }],
  });

  pushDispatchCoverage({
    result,
    failures: [],
    categoryIssues: [],
    examined: 0,
    categoriesExamined: 0,
    truncated: false,
    objcListScanTruncated: false,
    objcClassListScanTruncated: false,
    fixups: {
      kind: "none",
      formats: [],
      failures: [],
      issues: [],
      decode: (_address, raw) => ({ kind: "rebase", target: raw }),
      examined: 0,
      decoded: 0,
      legacyRebaseStreams: 0,
      legacyBindStreams: 0,
      unreadRebaseBytes: 0,
      hasUnresolvedLegacyBytes: () => false,
    },
    declarations: {
      facet: "swift_declarations",
      examined: 0,
      decoded: 0,
      exhaustive: true,
      issues: [],
    },
    swift: {
      facet: "swift_conformances_static_witness_slots",
      examined: 0,
      decoded: 0,
      exhaustive: true,
      issues: [],
    },
    vtables: facts,
  });

  expect(
    result.coverage.find(
      ({ facet }) => facet === "swift_class_vtable_descriptors",
    ),
  ).toMatchObject({
    status: "partial",
    examined: 2,
    decoded: 1,
    reason: expect.stringContaining("0x234"),
  });
});

it("returns a located issue for an emitted unresolved witness slot", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const values = new Map<bigint, number>([
    [0x20cn, 0], // simple, unconditional conformance
    [0x500n, 3], // protocol descriptor kind
    [0x800n, 0], // module context
    [0x50cn, 0], // signature count
    [0x510n, 1], // witness requirement count
    [0x2b0n, 16], // nominal type descriptor kind
    [0x518n, 1], // function witness requirement
  ]);
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => false,
    markTruncated: () => {
      budget.truncated = true;
    },
    admit: () => true,
  };
  const facts = decodeSwiftDispatchFacets({
    sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
    segments: [],
    readers: {
      u32: (address) => values.get(address) ?? 0,
      i32: (address) => values.get(address) ?? 0,
      pointer: (address) => (address === 0x380n ? 0x200n : 0x900n),
      resolvePointer: (address) => ({
        kind: "raw",
        target: address === 0x380n ? 0x200n : 0x900n,
      }),
      string: (address) => (address === 0x600n ? "Proto" : "Widget"),
      location: swiftFixtureLocation,
      targetLocation: swiftFixtureLocation,
      evidence: swiftFixtureEvidence,
      offset: (address) => Number(address),
    },
    relative: (field) => ({
      kind: "target",
      target:
        new Map<bigint, bigint>([
          [0x100n, 0x200n],
          [0x200n, 0x500n],
          [0x508n, 0x600n],
          [0x504n, 0x800n],
          [0x808n, 0x820n],
          [0x204n, 0x2b0n],
          [0x2b8n, 0x700n],
          [0x208n, 0x380n],
        ]).get(field) ?? 0n,
    }),
    budget,
    result,
  });

  expect(result.swift_dispatch_slots[0]?.decode.status).toBe("partial");
  expect(facts).toMatchObject({
    facet: "swift_conformances_static_witness_slots",
    exhaustive: false,
    issues: [{ code: "witness_slot_unresolved", location: "0x388" }],
  });
});

it("decodes a retroactive static witness slot when flags include retroactive bit 0x40", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const values = new Map<bigint, number>([
    [0x20cn, 0x48], // kind 1 (0x08) + retroactive conformance (0x40)
    [0x500n, 3], // protocol descriptor kind
    [0x800n, 0], // module context
    [0x50cn, 0], // signature count
    [0x510n, 1], // witness requirement count
    [0x2b0n, 16], // nominal type descriptor kind
    [0x518n, 1], // synchronous function witness requirement
  ]);
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => false,
    markTruncated: () => {
      budget.truncated = true;
    },
    admit: () => true,
  };
  const facts = decodeSwiftDispatchFacets({
    sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
    segments: [
      {
        address: 0x900n,
        size: 0x100n,
        offset: 0x900,
        executable: true,
      },
    ],
    readers: {
      u32: (address) => values.get(address) ?? 0,
      i32: (address) => values.get(address) ?? 0,
      pointer: (address) => (address === 0x380n ? 0x200n : 0x900n),
      resolvePointer: (address) => ({
        kind: "raw",
        target:
          address === 0x2a0n ? 0x2b0n : address === 0x380n ? 0x200n : 0x900n,
      }),
      string: (address) => (address === 0x600n ? "Proto" : "Widget"),
      location: swiftFixtureLocation,
      targetLocation: swiftFixtureLocation,
      evidence: swiftFixtureEvidence,
      offset: (address) => Number(address),
    },
    relative: (field) => ({
      kind: "target",
      target:
        new Map<bigint, bigint>([
          [0x100n, 0x200n],
          [0x200n, 0x500n],
          [0x508n, 0x600n],
          [0x504n, 0x800n],
          [0x808n, 0x820n],
          [0x204n, 0x2a0n], // indirect pointer to type descriptor
          [0x2b8n, 0x700n],
          [0x208n, 0x380n],
        ]).get(field) ?? 0n,
    }),
    budget,
    result,
  });

  expect(result.swift_conformances[0]).toMatchObject({
    type_name: "Widget",
    protocol_name: "Proto",
    decode: { status: "decoded", reason: null },
  });
  expect(result.swift_dispatch_slots).toHaveLength(1);
  expect(result.swift_dispatch_slots[0]).toMatchObject({
    slot_index: 1,
    implementation_address: "0x900",
    decode: { status: "decoded", reason: null },
  });
  expect(facts).toMatchObject({
    facet: "swift_conformances_static_witness_slots",
    exhaustive: true,
    examined: 1,
    decoded: 1,
    issues: [],
  });
});

it("retains partial coverage for retroactive conformance when conditional requirement flags are set", () => {
  const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
  const values = new Map<bigint, number>([
    [0x20cn, 0x148], // kind 1 (0x08) + retroactive (0x40) + conditional requirements (0x100)
    [0x500n, 3], // protocol descriptor kind
    [0x800n, 0], // module context
    [0x50cn, 0], // signature count
    [0x510n, 1], // witness requirement count
    [0x2b0n, 16], // nominal type descriptor kind
  ]);
  const budget: DispatchRecordBudget = {
    truncated: false,
    isFull: () => false,
    markTruncated: () => {},
    admit: () => true,
  };
  const facts = decodeSwiftDispatchFacets({
    sections: [{ name: "__swift5_proto", address: 0x100n, size: 4 }],
    segments: [],
    readers: {
      u32: (address) => values.get(address) ?? 0,
      i32: (address) => values.get(address) ?? 0,
      pointer: () => 0n,
      resolvePointer: (address) => ({
        kind: "raw",
        target: address === 0x2a0n ? 0x2b0n : 0x200n,
      }),
      string: (address) => (address === 0x600n ? "Proto" : "Widget"),
      location: swiftFixtureLocation,
      targetLocation: swiftFixtureLocation,
      evidence: swiftFixtureEvidence,
      offset: (address) => Number(address),
    },
    relative: (field) => ({
      kind: "target",
      target:
        new Map<bigint, bigint>([
          [0x100n, 0x200n],
          [0x200n, 0x500n],
          [0x508n, 0x600n],
          [0x504n, 0x800n],
          [0x808n, 0x820n],
          [0x204n, 0x2a0n],
          [0x2b8n, 0x700n],
          [0x208n, 0x380n],
        ]).get(field) ?? 0n,
    }),
    budget,
    result,
  });

  expect(result.swift_conformances[0]).toMatchObject({
    decode: {
      status: "partial",
      reason:
        "Conditional, generic, resilient or missing static witness table is not decoded",
    },
  });
  expect(result.swift_dispatch_slots).toHaveLength(0);
  expect(facts).toMatchObject({
    facet: "swift_conformances_static_witness_slots",
    exhaustive: false,
    examined: 1,
    decoded: 0,
    issues: [
      {
        code: "conformance_decode_partial",
        message:
          "Conditional, generic, resilient or missing static witness table is not decoded",
        location: "0x200",
      },
    ],
  });
});

describe("Swift vtable coverage facts: unsupported pointer fixup coverage", () => {
  it("marks pointer fixup coverage partial for an unsupported format with no decoded pointers", () => {
    const result = objcSwiftMetadataSchema.parse({ db_save_result: null });
    pushDispatchCoverage({
      result,
      failures: [],
      categoryIssues: [],
      examined: 0,
      categoriesExamined: 0,
      truncated: false,
      objcListScanTruncated: false,
      objcClassListScanTruncated: false,
      fixups: {
        kind: "chained",
        formats: ["format-99"],
        failures: ["Unsupported chained pointer format 99"],
        issues: [
          issue(
            "pointer_fixups",
            "unsupported_pointer_format",
            "Unsupported chained pointer format 99",
            "0x1000",
          ),
        ],
        decode: () => ({
          kind: "unsupported",
          reason: "Unsupported chained pointer format 99",
        }),
        examined: 0,
        decoded: 0,
        legacyRebaseStreams: 0,
        legacyBindStreams: 0,
        unreadRebaseBytes: 0,
        hasUnresolvedLegacyBytes: () => false,
      },
      declarations: {
        facet: "swift_declarations",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
      swift: {
        facet: "swift_conformances_static_witness_slots",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
      vtables: {
        facet: "swift_class_vtable_descriptors",
        examined: 0,
        decoded: 0,
        exhaustive: true,
        issues: [],
      },
    });

    expect(
      result.coverage.find(({ facet }) => facet === "pointer_fixups"),
    ).toMatchObject({
      status: "partial",
      examined: 0,
      decoded: 0,
      reason: expect.stringContaining("0x1000"),
    });
  });
});
