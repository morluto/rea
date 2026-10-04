import { describe, expect, it } from "vitest";

import {
  resolveArtifactIntegrityPolicy,
  resolveNativeMountPolicy,
} from "./ArtifactInventory/policy.js";

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

  it("admits parsed continuation intent only under operator policy", () => {
    expect(() =>
      resolveArtifactIntegrityPolicy({ mode: "record-and-continue" }, false),
    ).toThrow("requires explicit approval and operator policy");
    expect(
      resolveArtifactIntegrityPolicy({ mode: "record-and-continue" }, true),
    ).toEqual({ mode: "record-and-continue" });
  });
});
