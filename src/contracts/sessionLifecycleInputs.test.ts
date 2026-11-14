import { describe, expect, it } from "vitest";

import { openBinaryInputSchema } from "./sessionLifecycleInputs.js";

describe("open_binary raw-binary input contract", () => {
  it("accepts header detection without architecture", () => {
    expect(
      openBinaryInputSchema.safeParse({ path: "/tmp/fixture.bin" }).success,
    ).toBe(true);
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/legacy.com",
        format: "dos-com",
      }).success,
    ).toBe(true);
  });
  it("accepts raw-binary with architecture and entry", () => {
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/ecu.bin",
        format: "raw-binary",
        architecture: "arm",
        entry_point: "0x8000000",
      }).success,
    ).toBe(true);
  });
  it("rejects raw-binary without architecture or entry", () => {
    const parsed = openBinaryInputSchema.safeParse({
      path: "/tmp/ecu.bin",
      format: "raw-binary",
    });
    expect(parsed.success).toBe(false);
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/ecu.bin",
        format: "raw-binary",
        architecture: "arm",
      }).success,
    ).toBe(false);
  });
  it("rejects architecture without format=raw-binary", () => {
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/ecu.bin",
        architecture: "arm",
        entry_point: "0x8000000",
      }).success,
    ).toBe(false);
  });
});

describe("open_binary load input pairing", () => {
  const issuePath = (input: Record<string, unknown>) => {
    const parsed = openBinaryInputSchema.safeParse({
      path: "/tmp/ecu.bin",
      ...input,
    });
    return parsed.success ? undefined : parsed.error.issues[0]?.path;
  };
  it.each([
    [{ format: "raw-binary" }, "architecture"],
    [{ format: "raw-binary", architecture: "arm" }, "entry_point"],
    [{ architecture: "arm", entry_point: "0x8000000" }, "architecture"],
    [{ entry_point: "0x8000000" }, "entry_point"],
    [{ format: "dos-com", architecture: "x86" }, "architecture"],
    [{ format: "gamecube-dol", architecture: "x86" }, "architecture"],
  ])("keeps the path of the legacy pairing issue %j", (input, field) => {
    expect(issuePath(input)).toEqual([field]);
  });
  it.each([
    [{ base_address: "0x8000000" }, "base_address"],
    [
      { format: "dos-com", architecture_variant: "armv7-m" },
      "architecture_variant",
    ],
    [
      { format: "gamecube-dol", vector_table_address: "0x0" },
      "vector_table_address",
    ],
    [
      {
        format: "raw-binary",
        architecture: "x86",
        architecture_variant: "armv7-m",
        entry_point: "0x1000",
      },
      "architecture_variant",
    ],
    [
      {
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
        base_address: "0x8000000",
        entry_point: "0x8000000",
        vector_table_address: "0x8000000",
      },
      "vector_table_address",
    ],
    [
      {
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
      },
      "base_address",
    ],
    [
      {
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
        entry_point: "0x8000000",
      },
      "base_address",
    ],
    [
      { format: "raw-binary", architecture: "arm", base_address: "0x8000000" },
      "base_address",
    ],
    [
      {
        format: "raw-binary",
        architecture: "x86",
        base_address: "0x7c00",
        entry_point: "0x7c00",
      },
      "base_address",
    ],
  ])("names the input to correct for %j", (input, field) => {
    expect(issuePath(input)).toEqual([field]);
  });
  it("lets an M-profile variant with a base omit entry_point", () => {
    expect(
      issuePath({
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv7-m",
        base_address: "0x08000000",
      }),
    ).toBeUndefined();
  });
});
