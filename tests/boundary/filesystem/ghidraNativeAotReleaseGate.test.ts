import { describe, expect, it } from "vitest";

import { ghidraReleaseLineAccepted } from "../../../scripts/lib/ghidra-nativeaot-release-gate.mjs";

// The NativeAOT lane keeps its own admission gate, separate from
// `GhidraReleasePolicy`. When the certified build moved from 12.1.4 to 12.2 this
// predicate stayed hard-coded to `12.1.x`, so certification alone left the lane
// rejecting the verified release. These cases pin the widened line.
describe("ghidraReleaseLineAccepted", () => {
  it("accepts the verified release", () => {
    expect(ghidraReleaseLineAccepted("12.2")).toBe(true);
  });

  it("keeps the earlier accepted line", () => {
    expect(ghidraReleaseLineAccepted("12.1.4")).toBe(true);
    expect(ghidraReleaseLineAccepted("12.1.2")).toBe(true);
  });

  it("accepts later releases on the same major", () => {
    expect(ghidraReleaseLineAccepted("12.3")).toBe(true);
    expect(ghidraReleaseLineAccepted("12.3.1")).toBe(true);
  });

  it("accepts a suffixed release version", () => {
    expect(ghidraReleaseLineAccepted("12.2-DEV")).toBe(true);
  });

  it("rejects releases below the accepted line", () => {
    expect(ghidraReleaseLineAccepted("12.0.4")).toBe(false);
    expect(ghidraReleaseLineAccepted("11.4")).toBe(false);
  });

  it("rejects another major", () => {
    expect(ghidraReleaseLineAccepted("13.0")).toBe(false);
    expect(ghidraReleaseLineAccepted("13.1")).toBe(false);
  });

  it("rejects a missing or malformed version", () => {
    expect(ghidraReleaseLineAccepted(undefined)).toBe(false);
    expect(ghidraReleaseLineAccepted(null)).toBe(false);
    expect(ghidraReleaseLineAccepted("")).toBe(false);
    expect(ghidraReleaseLineAccepted("latest")).toBe(false);
  });
});
