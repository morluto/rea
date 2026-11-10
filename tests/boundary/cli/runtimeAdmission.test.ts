import { describe, expect, it } from "vitest";

import { satisfiesNodeRange } from "../../../scripts/lib/runtime-admission.mjs";

describe("satisfiesNodeRange", () => {
  it("admits a caret floor and later patches or minors in that major", () => {
    expect(satisfiesNodeRange("^22.23.4", "22.23.4")).toBe(true);
    expect(satisfiesNodeRange("^22.23.4", "22.23.5")).toBe(true);
    expect(satisfiesNodeRange("^22.23.4", "22.24.0")).toBe(true);
    expect(satisfiesNodeRange("^22.23.4", "22.23.3")).toBe(false);
    expect(satisfiesNodeRange("^22.23.4", "22.22.9")).toBe(false);
  });

  it("rejects a higher major under a caret and admits it under a minimum", () => {
    expect(satisfiesNodeRange("^22.23.4", "23.0.0")).toBe(false);
    expect(satisfiesNodeRange(">=22.23.4", "23.0.0")).toBe(true);
    expect(satisfiesNodeRange(">=22.23.4", "22.23.4")).toBe(true);
    expect(satisfiesNodeRange(">=22.23.4", "22.23.3")).toBe(false);
    expect(satisfiesNodeRange(">=22.23.4", "22.22.0")).toBe(false);
  });

  it("admits either clause of a union", () => {
    const range = "^22.23.4 || >=26.12.1";
    expect(satisfiesNodeRange(range, "22.23.4")).toBe(true);
    expect(satisfiesNodeRange(range, "26.12.1")).toBe(true);
    expect(satisfiesNodeRange(range, "27.0.0")).toBe(true);
    expect(satisfiesNodeRange(range, "24.0.0")).toBe(false);
    expect(satisfiesNodeRange(range, "26.12.0")).toBe(false);
  });

  it("rejects prerelease and non-release spellings", () => {
    expect(satisfiesNodeRange("^22.23.4", "22.23.4-rc.1")).toBe(false);
    expect(satisfiesNodeRange(">=22.23.4", "22.23.4-rc.1")).toBe(false);
    expect(satisfiesNodeRange("^22.23.4", "not-a-version")).toBe(false);
    expect(satisfiesNodeRange("^22.23.4", "22.23")).toBe(false);
  });
});
