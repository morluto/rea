import { describe, expect, it } from "vitest";

import { ghidraStartupTimeoutFromEnvironment } from "./GhidraDefaults.js";

describe("ghidraStartupTimeoutFromEnvironment", () => {
  it("keeps the default when the override is absent or empty", () => {
    expect(ghidraStartupTimeoutFromEnvironment({})).toBe(330_000);
    expect(
      ghidraStartupTimeoutFromEnvironment({
        REA_GHIDRA_STARTUP_TIMEOUT_MS: " ",
      }),
    ).toBe(330_000);
  });

  it("uses a positive integer override", () => {
    expect(
      ghidraStartupTimeoutFromEnvironment({
        REA_GHIDRA_STARTUP_TIMEOUT_MS: "900000",
      }),
    ).toBe(900_000);
  });

  it("falls back to the default for invalid values", () => {
    for (const value of ["0", "-5", "abc", "1.5"]) {
      expect(
        ghidraStartupTimeoutFromEnvironment({
          REA_GHIDRA_STARTUP_TIMEOUT_MS: value,
        }),
      ).toBe(330_000);
    }
  });
});
