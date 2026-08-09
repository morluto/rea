import { describe, expect, it } from "vitest";

import {
  resolveArtifactIntegrityPolicy,
  resolveNativeMountPolicy,
} from "../../../src/application/ArtifactInventory/policy.js";

describe("artifact inventory policy resolution", () => {
  it("admits native mounting only when caller and operator both allow it", () => {
    expect(resolveNativeMountPolicy(false, true)).toEqual({
      status: "disabled",
    });
    expect(() => resolveNativeMountPolicy(true, false)).toThrow(
      "disabled by operator policy",
    );
    expect(resolveNativeMountPolicy(true, true)).toEqual({
      status: "approved",
    });
  });

  it("projects strict integrity without dormant continuation state", () => {
    expect(resolveArtifactIntegrityPolicy({ mode: "fail" }, true)).toEqual({
      mode: "fail",
    });
  });

  it("admits parsed continuation intent only under operator policy", () => {
    expect(() =>
      resolveArtifactIntegrityPolicy(
        { mode: "record-and-continue", maxMismatches: 10 },
        false,
      ),
    ).toThrow("requires explicit approval and operator policy");
    expect(
      resolveArtifactIntegrityPolicy(
        { mode: "record-and-continue", maxMismatches: 10 },
        true,
      ),
    ).toEqual({ mode: "record-and-continue", maxMismatches: 10 });
  });
});
