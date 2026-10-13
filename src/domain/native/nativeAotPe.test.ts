import { describe, expect, it } from "vitest";
import { nativeMetadataRecoverySummarySchema } from "./nativeMetadataRecovery.js";
import {
  NATIVE_AOT_MAX_REPORT_BYTES,
  parseNativeAotPe,
} from "./nativeAotPe.js";
import {
  nativeAotPeDigest,
  nativeAotPeFixture,
} from "../../../tests/fixtures/nativeaotPe.js";
const SUMMARY_BUDGET = NATIVE_AOT_MAX_REPORT_BYTES;

describe("read-only NativeAOT PE parser", () => {
  it("recovers a bounded RTR9.1 type graph and frozen literal from captured bytes", () => {
    const bytes = nativeAotPeFixture();
    const before = Buffer.from(bytes);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
      "0x140000000",
    );
    expect(bytes).toEqual(before);
    expect(parsed.summary).toMatchObject({
      format: "dotnet-nativeaot",
      status: "complete",
      analysis_mode: "read-only-derived-overlay",
      format_major: 9,
      format_minor: 1,
      method_tables: 3,
      frozen_strings: [
        { address: "0x140002300", value: "REA_NATIVEAOT_FROZEN" },
      ],
      derived_overlay: { address: "0x140002380", size_bytes: 1 },
      coverage: {
        basis: "raw-image-and-rehydrated-pointer-scan",
        method_tables_recovered: 3,
        frozen_string_candidates: 1,
      },
    });
    expect(parsed.readTypeDetail("0x140002280", SUMMARY_BUDGET)).toMatchObject({
      source: "read-only-derived-overlay",
      method_table_address: "0x140002280",
      related_type: { address: "0x140002200", type: null },
      virtual_slots: [{ slot: 0, target_address: "0x140001040" }],
    });
    expect(nativeMetadataRecoverySummarySchema.parse(parsed.summary)).toEqual(
      parsed.summary,
    );
  });

  it("fails closed on snapshot identity mismatch", () => {
    const bytes = nativeAotPeFixture();
    expect(() =>
      parseNativeAotPe(bytes, "0".repeat(64), SUMMARY_BUDGET),
    ).toThrow(/digest/iu);
  });

  it("reports a detected but unsupported RTR version as partial without guessed types", () => {
    const bytes = nativeAotPeFixture(10, 0);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
    );
    expect(parsed.summary).toMatchObject({
      status: "partial",
      format_major: 10,
      format_minor: 0,
      method_tables: 0,
      types: [],
    });
  });

  it("does not discover an RTR directory in raw padding beyond VirtualSize", () => {
    const bytes = nativeAotPeFixture();
    const sectionTable = 0x98 + 0xf0;
    const dataSection = sectionTable + 40;
    bytes.writeUInt32LE(0x20, dataSection + 8);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
    );
    expect(parsed.summary).toMatchObject({
      status: "not_applicable",
      reason:
        "No supported ReadyToRun directory signature was found in initialized non-executable PE sections.",
      method_tables: 0,
    });
  });

  it("uses raw size as the virtual extent when VirtualSize is zero", () => {
    const bytes = nativeAotPeFixture();
    const sectionTable = 0x98 + 0xf0;
    bytes.writeUInt32LE(0, sectionTable + 40 + 8);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
    );
    expect(parsed.summary).toMatchObject({
      status: "complete",
      method_tables: 3,
      derived_overlay: { address: "0x140002380", size_bytes: 1 },
    });
  });

  it("accepts executable-section targets in the zero-filled virtual tail", () => {
    const bytes = nativeAotPeFixture();
    const sectionTable = 0x98 + 0xf0;
    bytes.writeUInt32LE(0x300, sectionTable + 8);
    const slotOffset = 0x600 + (0x2280 - 0x2000) + 24;
    // RVA 0x1200 is executable-section zero fill: virtual size 0x300, raw size 0x200.
    bytes.writeBigUInt64LE(0x140001200n, slotOffset);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
      "0x140000000",
    );
    expect(parsed.summary).toMatchObject({
      status: "complete",
      method_tables: 3,
    });
    expect(parsed.readTypeDetail("0x140002280", SUMMARY_BUDGET)).toMatchObject({
      virtual_slots: [{ slot: 0, target_address: "0x140001200" }],
    });
  });

  it("does not claim an image mapping when Ghidra rebased the image", () => {
    const bytes = nativeAotPeFixture();
    expect(
      parseNativeAotPe(
        bytes,
        nativeAotPeDigest(bytes),
        SUMMARY_BUDGET,
        "0x180000000",
      ).summary.reason,
    ).toMatch(/preferred image base/iu);
  });

  it("reports an unsupported hydration opcode as partial without mutating the snapshot", () => {
    const bytes = nativeAotPeFixture();
    bytes.writeUInt8(6, 0x704);
    const before = Buffer.from(bytes);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      SUMMARY_BUDGET,
    );
    expect(bytes).toEqual(before);
    expect(parsed.summary).toMatchObject({
      status: "partial",
      derived_overlay: null,
      diagnostics: [
        expect.stringContaining("Unsupported DEHYDRATED_DATA command"),
      ],
    });
  });
});

describe("NativeAOT PE signature admission", () => {
  it.each([
    ["MZ", "Not a PE image"],
    ["PE", "Invalid PE signature"],
  ])(
    "rejects a high-bit lookalike of the %s signature",
    (signature, reason) => {
      const bytes = nativeAotPeFixture();
      const offset = signature === "MZ" ? 0 : bytes.readUInt32LE(0x3c);
      for (const position of [offset, offset + 1])
        bytes.writeUInt8(bytes.readUInt8(position) | 0x80, position);
      expect(
        parseNativeAotPe(bytes, nativeAotPeDigest(bytes), SUMMARY_BUDGET)
          .summary,
      ).toMatchObject({ status: "not_applicable", reason });
    },
  );
});
