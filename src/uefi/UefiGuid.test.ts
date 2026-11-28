import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { formatGuidLittleEndian, guidBytesLittleEndian } from "./UefiGuid.js";

const ffs2RawBytes = Buffer.from([
  0x78, 0xe5, 0x8c, 0x8c, 0x3d, 0x8a, 0x1c, 0x4f, 0x99, 0x35, 0x89, 0x61, 0x85,
  0xc3, 0x2d, 0xd3,
]);

// EFI_FIRMWARE_FILE_SYSTEM3_GUID as EDK II stores it in a volume header.
const ffs3RawBytes = Buffer.from([
  0x7a, 0xc0, 0x73, 0x54, 0xcb, 0x3d, 0xca, 0x4d, 0xbd, 0x6f, 0x1e, 0x96, 0x89,
  0xe7, 0x34, 0x9a,
]);

const lzmaCustomRawBytes = Buffer.from([
  0x98, 0x58, 0x4e, 0xee, 0x14, 0x39, 0x59, 0x42, 0x9d, 0x6e, 0xdc, 0x7b, 0xd7,
  0x94, 0x03, 0xcf,
]);

const lzmaf86RawBytes = Buffer.from([
  0xbd, 0xe6, 0x2a, 0xd4, 0x52, 0x13, 0xfb, 0x4b, 0x90, 0x9a, 0xca, 0x72, 0xa6,
  0xea, 0xe8, 0x89,
]);

it("formats the FFS2 GUID at a nonzero offset ending at the buffer boundary", () => {
  const header = Buffer.alloc(32, 0xff);
  ffs2RawBytes.copy(header, 16);
  expect(formatGuidLittleEndian(header, 16)).toBe(
    "8c8ce578-8a3d-4f1c-9935-896185c32dd3",
  );
});

it("names the published FFS3 container GUID for its raw bytes", () => {
  expect(formatGuidLittleEndian(ffs3RawBytes, 0)).toBe(
    "5473c07a-3dcb-4dca-bd6f-1e9689e7349a",
  );
});

it("formats the LZMA custom compression GUID", () => {
  expect(formatGuidLittleEndian(lzmaCustomRawBytes, 0)).toBe(
    "ee4e5898-3914-4259-9d6e-dc7bd79403cf",
  );
});

it("formats the LZMAF86 compression GUID", () => {
  expect(formatGuidLittleEndian(lzmaf86RawBytes, 0)).toBe(
    "d42ae6bd-1352-4bfb-909a-ca72a6eae889",
  );
});

it("returns null for out-of-bounds and truncated reads", () => {
  const truncated = ffs2RawBytes.subarray(0, 15);
  expect(formatGuidLittleEndian(truncated, 0)).toBeNull();
  expect(formatGuidLittleEndian(Buffer.alloc(0), -1)).toBeNull();
  expect(formatGuidLittleEndian(ffs2RawBytes, 1)).toBeNull();
});

it("encodes signature GUID text back to the bytes a volume stores", () => {
  expect(
    guidBytesLittleEndian("8c8ce578-8a3d-4f1c-9935-896185c32dd3").equals(
      ffs2RawBytes,
    ),
  ).toBe(true);
  expect(
    guidBytesLittleEndian("5473c07a-3dcb-4dca-bd6f-1e9689e7349a").equals(
      ffs3RawBytes,
    ),
  ).toBe(true);
  expect(() => guidBytesLittleEndian("8c8ce578-8a3d-4f1c-9935")).toThrow(
    "invalid GUID text",
  );
  expect(() =>
    guidBytesLittleEndian("zzzzzzzz-8a3d-4f1c-9935-896185c32dd3"),
  ).toThrow("invalid GUID text");
});
