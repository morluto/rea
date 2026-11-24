import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { nativeObjcClassImportMachO } from "../../tests/fixtures/nativeObjcClassImportMachO.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.fixture.js";

const scan = (
  { bytes }: ReturnType<typeof nativeObjcClassImportMachO>,
  addresses: readonly string[],
  complete: boolean | undefined,
  maxRecords = 100,
) => {
  const result = decodeAppleDispatchMetadata(
    bytes,
    maxRecords,
    { path: "/fixture", sha256: "fixture" },
    "arm64",
    addresses,
    complete,
  );
  return {
    bindings: result.objc_class_import_bindings,
    coverage: result.objc_class_import_binding_coverage,
  };
};

it("retains exact address spellings and separates unusable candidates from mapped slots", () => {
  const fixture = nativeObjcClassImportMachO();
  const { address, nonClassAddress, unboundAddress } = fixture;
  const alternateAddress = "0X0100001000";
  const outside = "0x100002000";
  const result = scan(
    fixture,
    [
      address,
      nonClassAddress,
      "0x00000000000000001",
      outside,
      address,
      alternateAddress,
      unboundAddress,
    ],
    true,
  );
  expect(result.bindings).toEqual(
    [address, alternateAddress].map((requested_address) => ({
      requested_address,
      symbol: "_OBJC_CLASS_$_Document",
      binding_source: "bind",
      library_ordinal: 1,
      library: "/System/Library/Frameworks/AppKit.framework/AppKit",
      weak: false,
      addend: "0",
    })),
  );
  expect(result.coverage).toMatchObject({
    status: "partial",
    examined: 6,
    decoded: 2,
  });
  expect(result.coverage?.reason).toContain("not a 64-bit hexadecimal address");
  expect(result.coverage?.reason).toContain(outside);
});

it("keeps a bind with an invalid encoded ordinal visible as a coverage gap", () => {
  const fixture = nativeObjcClassImportMachO();
  fixture.bytes.writeUInt8(0x14, fixture.bindOffset); // The image declares one dylib.
  expect(scan(fixture, [fixture.address], true)).toMatchObject({
    bindings: [],
    coverage: {
      status: "partial",
      examined: 1,
      decoded: 0,
      reason: expect.stringContaining(
        `${fixture.address}: Dylib ordinal 4 exceeds the 1 declared dependencies`,
      ),
    },
  });
});

it("reports a selected raw slot as unknown when rebase applicability is incomplete", () => {
  const fixture = nativeObjcClassImportMachO();
  const { bytes, dyldCommandOffset, unboundAddress } = fixture;
  // A segment operand with a continuation byte but no terminating byte.
  Buffer.from([0x20, 0x80]).copy(bytes, 0x280);
  bytes.writeUInt32LE(0x280, dyldCommandOffset + 8);
  bytes.writeUInt32LE(2, dyldCommandOffset + 12);
  expect(scan(fixture, [unboundAddress], true)).toMatchObject({
    bindings: [],
    coverage: {
      status: "partial",
      examined: 1,
      decoded: 0,
      reason: expect.stringContaining(
        `${unboundAddress}: LC_DYLD_INFO pointer-fixup applicability was not completely decoded`,
      ),
    },
  });
});

it("reports unsupported fixups without inferring absent imports", () => {
  const fixture = nativeObjcClassImportMachO();
  fixture.bytes.writeUInt32LE(0, fixture.dyldCommandOffset + 20);
  expect(scan(fixture, [fixture.address], true)).toMatchObject({
    bindings: [],
    coverage: {
      status: "unsupported",
      examined: 0,
      decoded: 0,
      reason: expect.stringContaining("no supported pointer fixup commands"),
    },
  });
});

it.each([
  ["not_requested", true, true, 100, 0, null],
  ["partial", true, false, 100, 0, "max_records limit"],
  ["unknown", true, undefined, 100, 0, "did not state"],
  ["unknown", false, undefined, 100, 2, "did not state"],
  ["partial", false, true, 1, 1, "max_records limit"],
] as const)(
  "reports %s for empty=%s completeness=%s max_records=%s",
  (status, empty, complete, max, examined, reason) => {
    const fixture = nativeObjcClassImportMachO();
    const result = scan(
      fixture,
      empty ? [] : [fixture.address, fixture.unboundAddress],
      complete,
      max,
    );
    expect(result.bindings).toMatchObject(
      empty ? [] : [{ requested_address: fixture.address }],
    );
    expect(result.coverage).toMatchObject({
      status,
      examined,
      decoded: empty ? 0 : 1,
      reason: reason === null ? null : expect.stringContaining(reason),
    });
  },
);

it("retains the chained source of an exact class import", () => {
  const fixture = nativeObjcClassImportMachO("chained");
  expect(scan(fixture, [fixture.address], true)).toMatchObject({
    bindings: [
      {
        requested_address: fixture.address,
        symbol: "_OBJC_CLASS_$_Document",
        binding_source: "chained",
        library_ordinal: 1,
      },
    ],
    coverage: { status: "complete", examined: 1, decoded: 1 },
  });
});

it("propagates host capacity errors from candidate slot reads", () => {
  const fixture = nativeObjcClassImportMachO();
  const { bytes, address, slotOffset } = fixture;
  expect(scan(fixture, [address], true).coverage?.status).toBe("complete");
  const cause = Object.assign(new Error("host string capacity exceeded"), {
    code: "ERR_STRING_TOO_LONG",
  });
  const readWord = bytes.readBigUInt64LE.bind(bytes);
  const fault = vi
    .spyOn(bytes, "readBigUInt64LE")
    .mockImplementation((offset) => {
      if (offset === slotOffset) throw cause;
      return readWord(offset);
    });
  try {
    assert.throws(
      () => scan(fixture, [address], true),
      (caught) => caught === cause,
    );
  } finally {
    fault.mockRestore();
  }
});
