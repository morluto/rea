import { describe, expect, it } from "vitest";
import {
  LOONGARCH_DECLARED_FLAGS,
  loongarchAbiDeclaration,
  loongArchFloatAbi,
  loongArchObjectAbiVersion,
  loongArchUndeclaredFlags,
} from "./loongarchAbi.js";

describe("LoongArch e_flags declarations", () => {
  it.each([
    [0x0, "unspecified"],
    [0x1, "soft"],
    [0x2, "single"],
    [0x3, "double"],
    [0x4, "reserved"],
    [0x5, "reserved"],
    [0x6, "reserved"],
    [0x7, "reserved"],
  ] as const)("decodes floating-point modifier 0x%s", (flags, abi) => {
    expect(loongArchFloatAbi(flags)).toBe(abi);
  });

  it("reads the object ABI version only from EF_LARCH_OBJABI_V1", () => {
    expect(loongArchObjectAbiVersion(0x3)).toBe(0);
    expect(loongArchObjectAbiVersion(0x43)).toBe(1);
    // The v1 flag is independent of the floating-point modifier.
    expect(loongArchObjectAbiVersion(0x40)).toBe(1);
    expect(loongArchObjectAbiVersion(0x42)).toBe(1);
  });

  it.each([
    [0x43, 0],
    [0x3, 0],
    [0x80, 0x80],
    [0x1043, 0x1000],
    [0x80000003, 0x80000000],
    [0xffffffff, 0xffffffb8],
  ] as const)("retains undeclared bits in 0x%s", (flags, undeclared) => {
    expect(loongArchUndeclaredFlags(flags)).toBe(undeclared);
  });

  it("declares exactly the interpreted mask", () => {
    expect(LOONGARCH_DECLARED_FLAGS).toBe(0x47);
    expect(loongArchUndeclaredFlags(LOONGARCH_DECLARED_FLAGS)).toBe(0);
  });

  it("keeps object ABI v1 separate from old-world absence", () => {
    expect(loongarchAbiDeclaration(0x3)).toEqual({
      floatAbi: "double",
      objectAbiVersion: 0,
      undeclaredFlags: 0,
    });
    expect(loongarchAbiDeclaration(0x43)).toEqual({
      floatAbi: "double",
      objectAbiVersion: 1,
      undeclaredFlags: 0,
    });
  });
});
