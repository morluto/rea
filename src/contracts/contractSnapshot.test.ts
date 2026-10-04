import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
} from "./toolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "./managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "./managedWorkflowToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "./browserToolContracts.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "./browserScenarioToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "./javascriptRuntimeObservationToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";
import { TOOL_EFFECTS } from "./toolEffects.js";

const contractJsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-07", unrepresentable: "any" });

describe("tool contract surface", () => {
  it("advertises capture comparison alternatives on an object root", () => {
    const contract = BROWSER_TOOL_CONTRACTS.find(
      ({ name }) => name === "compare_web_captures",
    );
    if (contract === undefined)
      throw new Error("compare_web_captures contract is missing");

    const schema = contractJsonSchema(contract.inputSchema);
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "before",
        "after",
        "before_scenario",
        "after_scenario",
        "normalization",
      ]),
    );
    const example = contract.examples[0];
    if (example === undefined)
      throw new Error("compare_web_captures example is missing");
    if (
      !("before_scenario" in example.input) ||
      !("after_scenario" in example.input)
    )
      throw new Error("compare_web_captures example is not a scenario pair");
    const withoutNormalization = Object.fromEntries(
      Object.entries(example.input).filter(([key]) => key !== "normalization"),
    );
    expect(contract.inputSchema.safeParse(withoutNormalization).success).toBe(
      true,
    );
    const incomplete = Object.fromEntries(
      Object.entries(example.input).filter(([key]) => key !== "after_scenario"),
    );
    expect(contract.inputSchema.safeParse(incomplete).success).toBe(false);
  });

  it("audits every tool effect explicitly with no heuristic fallback", () => {
    const names = [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
      ...NATIVE_TOOL_CONTRACTS,
      ...ARTIFACT_TOOL_CONTRACTS,
      ...MANAGED_TOOL_CONTRACTS,
      ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
      ...BROWSER_TOOL_CONTRACTS,
      ...BROWSER_SCENARIO_TOOL_CONTRACTS,
      ...ELECTRON_TOOL_CONTRACTS,
      ...JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
      ...APPLICATION_TOOL_CONTRACTS,
      ...SESSION_TOOL_CONTRACTS,
    ].map(({ name }) => name);
    expect(Object.keys(TOOL_EFFECTS).sort()).toEqual(names.sort());
  });

  it("marks process scenario capture as open world", () => {
    expect(
      SESSION_TOOL_CONTRACTS.find(
        ({ name }) => name === "capture_process_scenario",
      )?.annotations.openWorldHint,
    ).toBe(true);
  });

  it("advertises evidence filesystem effects conservatively", () => {
    const exported = SESSION_TOOL_CONTRACTS.find(
      ({ name }) => name === "export_evidence_bundle",
    );
    const imported = SESSION_TOOL_CONTRACTS.find(
      ({ name }) => name === "import_evidence_bundle",
    );
    expect(exported?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(imported?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});
