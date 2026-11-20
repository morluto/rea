import { expect, it } from "vitest";
import {
  parseNativeAotPe,
  NATIVE_AOT_MAX_REPORT_BYTES,
} from "./nativeAotPe.js";
import {
  nativeAotPeHeaderIndirectionFixture,
  nativeAotPeOptionalHeaderFixture,
  nativeAotPeDigest,
  nativeAotPeFixture,
} from "../../../tests/fixtures/nativeaotPe.js";

it.each([
  { rva: 0x3f8, admitted: true },
  { rva: 0x3fc, admitted: false },
  { rva: 0x400, admitted: false },
])(
  "admits a header-backed TypeManager pointer only when all eight bytes are mapped ($rva)",
  ({ rva, admitted }) => {
    const bytes = nativeAotPeHeaderIndirectionFixture(rva);
    const result = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      NATIVE_AOT_MAX_REPORT_BYTES,
    );
    expect(result.summary.header_address !== null).toBe(admitted);
    if (!admitted)
      expect(result.summary).toMatchObject({
        status: "not_applicable",
        method_tables: 0,
        reason: { code: "no_rtr_directory" },
      });
  },
);

it.each([
  { optionalBytes: 56, admitted: false },
  { optionalBytes: 64, admitted: true },
])(
  "reads mapping fields only from the declared optional header ($optionalBytes bytes)",
  ({ optionalBytes, admitted }) => {
    const bytes = nativeAotPeOptionalHeaderFixture(optionalBytes);
    const result = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      NATIVE_AOT_MAX_REPORT_BYTES,
    );
    expect(result.summary.header_address !== null).toBe(admitted);
    if (!admitted)
      expect(result.summary).toMatchObject({
        status: "not_applicable",
        method_tables: 0,
        reason: { code: "optional_header_too_short" },
      });
  },
);

it.each([
  { virtualSize: 0x400, admitted: true },
  { virtualSize: 0x3ff, admitted: false },
])(
  "requires the last ReadyToRun row to fit the file-backed section ($virtualSize bytes)",
  ({ virtualSize, admitted }) => {
    const bytes = nativeAotPeFixture();
    // Move the two-row directory to the end of .rdata.
    bytes.copy(bytes, 0x9c0, 0x600, 0x640);
    bytes.fill(0, 0x600, 0x640);
    bytes.writeUInt32LE(virtualSize, 0x98 + 0xf0 + 40 + 8);

    const { summary } = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      NATIVE_AOT_MAX_REPORT_BYTES,
    );
    if (admitted)
      expect(summary).toMatchObject({
        header_address: "0x1400023c0",
        format_major: 9,
        format_minor: 1,
        method_tables: 3,
      });
    else
      expect(summary).toMatchObject({
        header_address: null,
        reason: { code: "no_rtr_directory" },
      });
  },
);
