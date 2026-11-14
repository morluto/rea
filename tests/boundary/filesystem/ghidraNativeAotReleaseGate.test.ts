import { describe, expect, it } from "vitest";

import {
  SUPPORTED_GHIDRA_FLOOR_VERSION,
  SUPPORTED_GHIDRA_VERSION,
  ghidraReleaseAccepted,
  ghidraReleaseLine,
} from "../../../src/ghidra/GhidraReleasePolicy.js";

// The NativeAOT lane used to keep its own `12.1.x` gate, so raising the verified
// build to 12.2 left that lane rejecting the release it was built for. It now
// asks the same policy the provider does; these cases pin the line that lane
// depends on and prove the two cannot drift apart again.
describe("NativeAOT lane release admission", () => {
  it("accepts the verified release", () => {
    expect(ghidraReleaseAccepted(SUPPORTED_GHIDRA_VERSION)).toBe(true);
  });

  it("keeps the accepted floor", () => {
    expect(ghidraReleaseAccepted(`${SUPPORTED_GHIDRA_FLOOR_VERSION}.4`)).toBe(
      true,
    );
    expect(ghidraReleaseAccepted("12.1.2")).toBe(true);
  });

  it("accepts later releases on the same major", () => {
    expect(ghidraReleaseAccepted("12.3")).toBe(true);
    expect(ghidraReleaseAccepted("12.3.1")).toBe(true);
  });

  it("rejects releases below the accepted line", () => {
    expect(ghidraReleaseAccepted("12.0.4")).toBe(false);
    expect(ghidraReleaseAccepted("11.4")).toBe(false);
  });

  it("rejects another major", () => {
    expect(ghidraReleaseAccepted("13.0")).toBe(false);
    expect(ghidraReleaseAccepted("13.1")).toBe(false);
  });

  it("rejects a missing or malformed version", () => {
    expect(ghidraReleaseAccepted(undefined)).toBe(false);
    expect(ghidraReleaseAccepted(null)).toBe(false);
    expect(ghidraReleaseAccepted("")).toBe(false);
    expect(ghidraReleaseAccepted("latest")).toBe(false);
  });

  it("names the accepted line the lane reports", () => {
    expect(ghidraReleaseLine()).toBe("12.x (>=12.1)");
  });
});
