import { describe, expect, it } from "vitest";

import {
  parseArtifactInventoryEvidence,
  tryAssembleInventorySet,
} from "./artifactInventoryEvidence.js";

describe("inventory validation failure channels", () => {
  it("returns the empty-pages leaf as Result without throwing", () => {
    const result = tryAssembleInventorySet([]);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "empty",
        message: "Artifact inventory requires Evidence pages",
      },
    });
  });

  it("keeps the throwing entry contract for empty input", () => {
    expect(() => parseArtifactInventoryEvidence([])).toThrowError(
      "Artifact inventory requires Evidence pages",
    );
  });
});
