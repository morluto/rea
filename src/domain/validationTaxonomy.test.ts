import { describe, expect, it } from "vitest";

import {
  parseArtifactInventoryEvidence,
  tryAssembleInventorySet,
} from "./artifactInventoryEvidence.js";
import { EvidenceReferenceError } from "./evidenceErrors.js";
import type { ReferenceSourceReaderError } from "../reference/ReferenceSourceReaderTypes.js";

/**
 * The three validation taxonomies and their disjoint codes:
 * - Filesystem reader: cancelled | invalid-root | io | unsupported
 *   (per-entry: cancelled | changed | io | symlink | unsupported).
 * - Session evidence references: missing | wrong_operation |
 *   wrong_predicate | identity_mismatch.
 * - Inventory assembly: TypeError strings, migrating to Result leaves
 *   starting with the empty-pages code below.
 */
const readerCodes: readonly ReferenceSourceReaderError["code"][] = [
  "cancelled",
  "invalid-root",
  "io",
  "unsupported",
];

const referenceReasons = (
  [
    "missing",
    "wrong_operation",
    "wrong_predicate",
    "identity_mismatch",
  ] as const
).map(
  (reason) =>
    new EvidenceReferenceError("ev_test", reason, "expected", null).reason,
);

describe("validation taxonomy mapping", () => {
  it("keeps session reference reasons disjoint from reader codes", () => {
    for (const reason of referenceReasons)
      expect(readerCodes).not.toContain(reason);
  });

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
