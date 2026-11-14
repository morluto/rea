import { describe, expect, it } from "vitest";
import { parseExecutableHeader } from "./binaryTarget.js";

const header = (
  little: boolean,
  bits: 32 | 64 = 64,
  flags = 0x3,
  type = 3,
  machine = 258,
): Buffer => {
  const bytes = Buffer.alloc(bits === 32 ? 52 : 64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, bits === 32 ? 1 : 2, little ? 1 : 2, 1]);
  if (little) {
    bytes.writeUInt16LE(type, 16);
    bytes.writeUInt16LE(machine, 18);
    bytes.writeUInt32LE(1, 20);
    bytes.writeUInt16LE(bits === 32 ? 52 : 64, bits === 32 ? 40 : 52);
    bytes.writeUInt32LE(flags, bits === 32 ? 36 : 48);
  } else {
    bytes.writeUInt16BE(type, 16);
    bytes.writeUInt16BE(machine, 18);
    bytes.writeUInt32BE(1, 20);
    bytes.writeUInt16BE(bits === 32 ? 52 : 64, bits === 32 ? 40 : 52);
    bytes.writeUInt32BE(flags, bits === 32 ? 36 : 48);
  }
  return bytes;
};

describe("LoongArch ELF header declarations", () => {
  it("retains the old-world declaration (EF_LARCH_OBJABI_V1 clear)", () => {
    const parsed = parseExecutableHeader(header(true, 64, 0x3, 3), "x64");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toEqual({
      format: "elf",
      architecture: "loongarch",
      availableArchitectures: ["loongarch"],
      loongarch: {
        elfClass: 64,
        byteOrder: "little",
        type: 3,
        flags: 0x3,
        floatAbi: "double",
        objectAbiVersion: 0,
        undeclaredFlags: 0,
      },
    });
  });

  it("retains the new-world declaration (EF_LARCH_OBJABI_V1 set)", () => {
    const parsed = parseExecutableHeader(header(true, 64, 0x43, 2), "x64");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toMatchObject({
      format: "elf",
      architecture: "loongarch",
      loongarch: {
        elfClass: 64,
        byteOrder: "little",
        type: 2,
        flags: 0x43,
        floatAbi: "double",
        objectAbiVersion: 1,
        undeclaredFlags: 0,
      },
    });
  });

  it("reads ELF64 flags at their own offset", () => {
    const bytes = header(true, 64);
    bytes.writeUInt32LE(0xdeadbeef, 36);
    bytes.writeUInt32LE(0x1043, 48);
    const parsed = parseExecutableHeader(bytes, "x64");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toMatchObject({
      architecture: "loongarch",
      loongarch: {
        flags: 0x1043,
        objectAbiVersion: 1,
        undeclaredFlags: 0x1000,
      },
    });
  });

  it("retains an ELF32 declaration without admitting a provider lane", () => {
    const parsed = parseExecutableHeader(header(true, 32, 0x3, 2), "x64");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toMatchObject({
      architecture: "loongarch",
      loongarch: { elfClass: 32, objectAbiVersion: 0 },
    });
  });

  it("retains a big-endian declaration for the lane to refuse", () => {
    const parsed = parseExecutableHeader(header(false, 64, 0x43, 3), "x64");
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value).toMatchObject({
      architecture: "loongarch",
      loongarch: { byteOrder: "big", objectAbiVersion: 1 },
    });
  });

  it("keeps an unknown e_machine outside the recognized family set", () => {
    expect(parseExecutableHeader(header(true, 64, 0x3, 3, 259), "x64")).toEqual(
      {
        ok: false,
        error: "unsupported ELF architecture: e_machine 259",
      },
    );
  });
});
