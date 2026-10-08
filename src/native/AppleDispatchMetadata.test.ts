import { describe, expect, it } from "vitest";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.js";

const base = 0x100000000n;
const fixture = (relative = false) => {
  const bytes = Buffer.alloc(2048);
  const u32 = (offset: number, value: number) =>
    bytes.writeUInt32LE(value, offset);
  const ptr = (offset: number, target: number) =>
    bytes.writeBigUInt64LE(base + BigInt(target), offset);
  u32(0, 0xfeedfacf);
  u32(4, 0x0100000c);
  u32(16, 1);
  u32(20, 152);
  u32(32, 0x19);
  u32(36, 152);
  bytes.write("__DATA", 40);
  ptr(56, 0);
  bytes.writeBigUInt64LE(2048n, 64);
  bytes.writeBigUInt64LE(2048n, 80);
  u32(92, 5);
  u32(96, 1);
  bytes.write("__objc_classlist", 104);
  bytes.write("__DATA", 120);
  ptr(136, 0x180);
  bytes.writeBigUInt64LE(8n, 144);
  u32(152, 0x180);
  ptr(0x180, 0x200);
  ptr(0x200, 0x280);
  ptr(0x220, 0x300);
  ptr(0x2a0, 0x380);
  u32(0x308, 16);
  ptr(0x318, 0x450);
  ptr(0x320, 0x480);
  ptr(0x330, 0x500);
  u32(0x380, 1);
  ptr(0x398, 0x450);
  bytes.write("Fixture\0", 0x450);
  bytes.write("performAction:\0", 0x460);
  u32(0x480, relative ? 0xc000000c : 24);
  u32(0x484, 1);
  if (relative) {
    bytes.writeInt32LE(0x460 - 0x488, 0x488);
    bytes.writeInt32LE(0x5c0 - 0x48c, 0x48c);
    bytes.writeInt32LE(0x700 - 0x490, 0x490);
  } else {
    ptr(0x488, 0x460);
    ptr(0x490, 0x5c0);
    ptr(0x498, 0x700);
  }
  u32(0x500, 32);
  u32(0x504, 1);
  ptr(0x508, 0x580);
  ptr(0x510, 0x5a0);
  ptr(0x518, 0x5c0);
  u32(0x580, 8);
  bytes.write("state\0", 0x5a0);
  bytes.write("i\0", 0x5c0);
  return bytes;
};
const provenance = { path: "/fixture/app", sha256: "a".repeat(64) };
describe("Apple dispatch binary metadata", () => {
  it.each([false, true])(
    "decodes stripped absolute/relative method lists (relative=%s) with exact offsets",
    (relative) => {
      const result = decodeAppleDispatchMetadata(
        fixture(relative),
        100,
        provenance,
      );
      expect(result.objc_classes).toMatchObject([
        {
          name: "Fixture",
          instance_size: 16,
          location: { address: "0x100000200", file_offset: 512 },
        },
        { name: "Fixture", is_meta_class: true },
      ]);
      expect(result.objc_dispatch_implementations).toMatchObject([
        {
          selector: "performAction:",
          implementation_address: "0x100000700",
          location: { file_offset: 0x488 },
          decode: { status: "decoded" },
        },
      ]);
      expect(result.objc_ivars).toMatchObject([
        {
          name: "state",
          type_encoding: "i",
          offset: 8,
          location: { file_offset: 0x508 },
        },
      ]);
    },
  );
  it("keeps unsupported pointers and record truncation explicit", () => {
    const bytes = fixture();
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 0x498);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      implementation_address: null,
      decode: { status: "partial" },
    });
    const truncated = decodeAppleDispatchMetadata(fixture(), 1, provenance);
    expect(truncated.coverage[0]?.reason).toContain("max_records_reached");
    expect(
      truncated.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({ status: "partial", reason: "max_records_reached" });
  });
  it("rejects malformed command and section boundaries", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(7, 36);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "command size",
    );
    expect(() =>
      decodeAppleDispatchMetadata(Buffer.alloc(10), 100, provenance),
    ).toThrow("Truncated");
  });
});

describe("universal Apple dispatch metadata", () => {
  it.each([false, true])("decodes selected FAT slices (fat64=%s)", (fat64) => {
    const thin = fixture();
    const offset = 256;
    const bytes = Buffer.alloc(offset + thin.length);
    bytes.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x0100000c, 8);
    if (fat64) {
      bytes.writeBigUInt64BE(BigInt(offset), 16);
      bytes.writeBigUInt64BE(BigInt(thin.length), 24);
    } else {
      bytes.writeUInt32BE(offset, 16);
      bytes.writeUInt32BE(thin.length, 20);
    }
    thin.copy(bytes, offset);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes[0]).toMatchObject({
      name: "Fixture",
      location: { address: "0x100000200", file_offset: offset + 512 },
    });
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      implementation_address: "0x100000700",
      location: { file_offset: offset + 0x488 },
    });
  });
});

describe("FAT64 dispatch slice validation", () => {
  const wrapped = () => {
    const thin = fixture();
    const bytes = Buffer.alloc(256 + thin.length);
    bytes.writeUInt32BE(0xcafebabf, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x0100000c, 8);
    bytes.writeBigUInt64BE(256n, 16);
    bytes.writeBigUInt64BE(BigInt(thin.length), 24);
    thin.copy(bytes, 256);
    return bytes;
  };

  it("rejects a truncated architecture table", () => {
    expect(() =>
      decodeAppleDispatchMetadata(wrapped().subarray(0, 32), 100, provenance),
    ).toThrow("Malformed FAT architecture table");
  });

  it.each([16, 24])(
    "checks the full 64-bit slice extent at field %i",
    (field) => {
      const bytes = wrapped();
      bytes.writeBigUInt64BE(0x100000000n, field);
      expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
        "FAT architecture 0 slice range extends beyond the file",
      );
    },
  );

  it("rejects ambiguous matching architectures", () => {
    const bytes = wrapped();
    bytes.writeUInt32BE(2, 4);
    bytes.copy(bytes, 40, 8, 40);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Ambiguous FAT architecture slice",
    );
  });

  it("rejects a missing selected architecture", () => {
    expect(() =>
      decodeAppleDispatchMetadata(wrapped(), 100, provenance, "x86_64"),
    ).toThrow("Requested FAT architecture is absent");
  });
});

describe("byte-swapped universal Apple dispatch metadata", () => {
  const wrapped = (fat64: boolean) => {
    const thin = fixture();
    const offset = 256;
    const bytes = Buffer.alloc(offset + thin.length);
    bytes.writeUInt32LE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
    bytes.writeUInt32LE(1, 4);
    bytes.writeUInt32LE(0x0100000c, 8);
    if (fat64) {
      bytes.writeBigUInt64LE(BigInt(offset), 16);
      bytes.writeBigUInt64LE(BigInt(thin.length), 24);
    } else {
      bytes.writeUInt32LE(offset, 16);
      bytes.writeUInt32LE(thin.length, 20);
    }
    thin.copy(bytes, offset);
    return bytes;
  };

  it.each([false, true])(
    "decodes selected little-endian FAT slices (fat64=%s)",
    (fat64) => {
      const result = decodeAppleDispatchMetadata(
        wrapped(fat64),
        100,
        provenance,
      );
      expect(result.objc_classes[0]).toMatchObject({
        name: "Fixture",
        location: { address: "0x100000200", file_offset: 256 + 512 },
      });
      expect(result.objc_dispatch_implementations[0]).toMatchObject({
        implementation_address: "0x100000700",
        location: { file_offset: 256 + 0x488 },
      });
    },
  );

  it.each([6, 16])(
    "states the header byte order when its architecture table is truncated at %i bytes",
    (length) => {
      expect(() =>
        decodeAppleDispatchMetadata(
          wrapped(false).subarray(0, length),
          100,
          provenance,
        ),
      ).toThrow(
        "Malformed FAT architecture table (FAT header byte order: little-endian)",
      );
    },
  );

  it("validates the selected thin slice's own byte order", () => {
    const bytes = wrapped(false);
    bytes.writeUInt32BE(0xfeedfacf, 256);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  });

  it("rejects a 32-bit slice payload inside a little-endian container", () => {
    const bytes = wrapped(false);
    bytes.writeUInt32BE(0xfeedface, 256);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  });

  it("checks the full little-endian FAT64 slice extent", () => {
    const bytes = wrapped(true);
    bytes.writeBigUInt64LE(0x100000000n, 16);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "FAT architecture 0 slice range extends beyond the file (FAT header byte order: little-endian)",
    );
  });
});
