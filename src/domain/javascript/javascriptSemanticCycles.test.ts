import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { expectImportCycles } from "../../../tests/fixtures/importCycles.js";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Cycles that already existed outside the semantic analysis hub. Membership is
 * exact so a new edge cannot hide inside the allow-list.
 */
const allowedCycles = [
  [
    "electronStaticAnalysisTypes.ts",
    "javascriptRouteFacts.ts",
    "javascriptSourceCoordinates.ts",
    "javascriptStaticAnalysisTypes.ts",
  ],
  [
    "javascriptRuntimeReconciliationActive.ts",
    "javascriptRuntimeReconciliationCaptureParsing.ts",
  ],
  ["javascriptStaticAnalysisFindings.ts", "javascriptStaticAnalysisState.ts"],
];

const allowedCycleEdges = [
  "electronStaticAnalysisTypes.ts -> javascriptStaticAnalysisTypes.ts",
  "javascriptRouteFacts.ts -> javascriptSourceCoordinates.ts",
  "javascriptSourceCoordinates.ts -> javascriptStaticAnalysisTypes.ts",
  "javascriptStaticAnalysisTypes.ts -> electronStaticAnalysisTypes.ts",
  "javascriptStaticAnalysisTypes.ts -> javascriptRouteFacts.ts",
  "javascriptRuntimeReconciliationActive.ts -> javascriptRuntimeReconciliationCaptureParsing.ts",
  "javascriptRuntimeReconciliationCaptureParsing.ts -> javascriptRuntimeReconciliationActive.ts",
  "javascriptStaticAnalysisFindings.ts -> javascriptStaticAnalysisState.ts",
  "javascriptStaticAnalysisState.ts -> javascriptStaticAnalysisFindings.ts",
].sort();

describe("javascript semantic import cycles", () => {
  it("keeps the semantic modules out of one import cycle", () => {
    expectImportCycles(root, allowedCycles, allowedCycleEdges);
  });
});
