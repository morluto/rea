import { describe, expect, it } from "vitest";

import { resolveArtifactIntegrityPolicy } from "./ArtifactInventory/policy.js";

describe("artifact inventory policy resolution", () => {
  it("preserves the selected integrity behavior without disabling verification", () => {
    expect(resolveArtifactIntegrityPolicy({ mode: "fail" })).toEqual({
      mode: "fail",
    });
    expect(
      resolveArtifactIntegrityPolicy({ mode: "record-and-continue" }),
    ).toEqual({ mode: "record-and-continue" });
  });
});
