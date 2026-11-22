import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { expectImportCycles } from "../../../tests/fixtures/importCycles.js";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Cycles that already existed outside the analysis-view hub. Membership is
 * exact so a new edge cannot hide inside the allow-list.
 */
const allowedCycles = [
  [
    "StateRecordChronology.ts",
    "environmentStateListQuery.ts",
    "environmentStateRules.ts",
    "environmentStateWriteRules.ts",
  ],
  ["environmentStateGate.ts", "environmentStateListFacts.ts"],
  ["environmentStateWriteAddress.ts", "environmentStateWriteEffects.ts"],
];

const allowedCycleEdges = [
  "StateRecordChronology.ts -> environmentStateRules.ts",
  "environmentStateListQuery.ts -> environmentStateRules.ts",
  "environmentStateRules.ts -> StateRecordChronology.ts",
  "environmentStateRules.ts -> environmentStateListQuery.ts",
  "environmentStateRules.ts -> environmentStateWriteRules.ts",
  "environmentStateWriteRules.ts -> environmentStateRules.ts",
  "environmentStateGate.ts -> environmentStateListFacts.ts",
  "environmentStateListFacts.ts -> environmentStateGate.ts",
  "environmentStateWriteAddress.ts -> environmentStateWriteEffects.ts",
  "environmentStateWriteEffects.ts -> environmentStateWriteAddress.ts",
].sort();

describe("analysis view import cycles", () => {
  it("keeps projectors from importing the request and result hub", () => {
    expectImportCycles(root, allowedCycles, allowedCycleEdges);
  });
});
