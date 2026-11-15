import { describe, expect, it } from "vitest";

import {
  openBinaryInputSchema,
  openBinaryTargetSelection,
} from "./sessionLifecycleInputs.js";

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
  it("accepts absolute dsym_path without format and rejects relative or headerless pairings", () => {
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/app",
        dsym_path: "/tmp/app.dSYM",
      }).success,
    ).toBe(true);
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/app",
        dsym_path: "rel/app.dSYM",
      }).success,
    ).toBe(false);
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/ecu.bin",
        format: "raw-binary",
        architecture: "arm",
        entry_point: "0x8000000",
        dsym_path: "/tmp/app.dSYM",
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["dsym_path"],
            message: expect.stringContaining("detected Mach-O"),
          }),
        ],
      },
    });
    expect(
      openBinaryInputSchema.safeParse({
        path: "/tmp/ecu.bin",
        format: "raw-binary",
        dsym_path: "/tmp/app.dSYM",
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["dsym_path"],
            message: expect.stringContaining("detected Mach-O"),
          }),
          expect.objectContaining({
            path: ["architecture"],
          }),
        ]),
      },
    });
  });
  it("forwards dsym_path to target selection only when provided", () => {
    expect(openBinaryTargetSelection({})).toEqual({});
    expect(openBinaryTargetSelection({ dsym_path: "/tmp/app.dSYM" })).toEqual({
      dsymPath: "/tmp/app.dSYM",
    });
  });
});
