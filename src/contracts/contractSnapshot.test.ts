import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCli } from "../cli.js";
import { createCliInventory } from "../../scripts/lib/product-catalog.mjs";

import { ENHANCED_TOOL_CONTRACTS } from "./enhancedToolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "./officialToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "./sessionToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { FIRMWARE_TOOL_CONTRACTS } from "./firmwareToolContracts.js";
import { ANDROID_TOOL_CONTRACTS } from "./androidToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "./managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "./managedWorkflowToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "./browserToolContracts.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "./browserScenarioToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "./javascriptRuntimeObservationToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";
import { TOOL_EFFECTS } from "./toolEffects.js";
import { TOOL_CONTRACTS } from "./toolContracts.js";
import {
  CLI_COMMAND_ALIASES,
  CLI_COMMAND_NAMES,
  CLI_COMMAND_TOOL_ALIASES,
  MCP_TOOLS_WITHOUT_DEDICATED_CLI,
} from "../cliCommandNames.js";

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
      ...ANDROID_TOOL_CONTRACTS,
      ...FIRMWARE_TOOL_CONTRACTS,
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

  it("accounts for every MCP tool on the CLI or marks it intentionally MCP-only", () => {
    const registeredCli = createCliInventory(createCli());
    const registeredCommandNames = new Set([
      ...registeredCli.primary,
      ...registeredCli.aliases.map(({ name }) => name),
    ]);
    const cliToolNames = new Set(
      registeredCli.primary.map((command) => command.replaceAll("-", "_")),
    );
    for (const [command, names] of Object.entries(CLI_COMMAND_TOOL_ALIASES)) {
      expect(registeredCommandNames.has(command)).toBe(true);
      for (const name of names) cliToolNames.add(name);
    }
    for (const command of CLI_COMMAND_NAMES)
      expect(registeredCommandNames.has(command)).toBe(true);
    for (const command of CLI_COMMAND_ALIASES)
      expect(registeredCommandNames.has(command)).toBe(true);
    const intentionalMcpOnly = new Set<string>(MCP_TOOLS_WITHOUT_DEDICATED_CLI);
    expect(
      [...intentionalMcpOnly].filter((name) => cliToolNames.has(name)).sort(),
    ).toEqual([]);
    const unaccounted = TOOL_CONTRACTS.map(({ name }) => name).filter(
      (name) => !cliToolNames.has(name) && !intentionalMcpOnly.has(name),
    );
    expect(unaccounted).toEqual([]);
    expect(new Set(MCP_TOOLS_WITHOUT_DEDICATED_CLI).size).toBe(
      MCP_TOOLS_WITHOUT_DEDICATED_CLI.length,
    );
    expect(
      MCP_TOOLS_WITHOUT_DEDICATED_CLI.every((name) =>
        TOOL_CONTRACTS.some((contract) => contract.name === name),
      ),
    ).toBe(true);
  });
});
