import { expect } from "vitest";

import { artifactComparisonResultSchema } from "../../src/domain/artifactComparison.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence, type Evidence } from "../../src/domain/evidence.js";
import { connectLocalToolsMcp } from "./localToolsMcp.js";

/** Return the inventory Evidence that an artifact inspection retains. */
export const inventoryEvidence = (inspection: unknown): Evidence => {
  const inventory = artifactInspectionResultSchema
    .parse(parseEvidence(inspection).normalized_result)
    .substeps.find(
      ({ operation }) => operation === "inventory_artifact",
    )?.evidence;
  if (inventory === undefined) throw new Error("Missing inventory Evidence");
  return parseEvidence(inventory);
};

/** Inspect artifact files and compare their inventories through MCP. */
export async function connectArtifactComparisonMcp() {
  const { call } = await connectLocalToolsMcp();
  const inspect = async (path: string): Promise<Evidence> => {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const response = await call("inspect_artifact", {});
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return inventoryEvidence(response.structuredContent);
  };
  const compare = async (left: Evidence, right: Evidence) => {
    const response = await call("compare_artifacts", { left, right });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return artifactComparisonResultSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
  };
  return { call, inspect, compare };
}
