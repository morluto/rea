import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../src/contracts/nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../src/contracts/artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "../src/contracts/managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../src/contracts/managedWorkflowToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "../src/contracts/browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../src/contracts/electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../src/contracts/applicationToolContracts.js";
import {
  enhancedOutputSchemas,
  managedOutputSchemas,
  managedWorkflowOutputSchemas,
  officialOutputSchemas,
  sessionOutputSchemas,
} from "../src/contracts/toolOutputSchemas.js";

const convertContractJsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    target: "draft-07",
    unrepresentable: "any",
  });

const jsonSchemaCache = new WeakMap<
  z.ZodType,
  ReturnType<typeof convertContractJsonSchema>
>();

const contractJsonSchema = (schema: z.ZodType) => {
  const cached = jsonSchemaCache.get(schema);
  if (cached !== undefined) return cached;
  const converted = convertContractJsonSchema(schema);
  jsonSchemaCache.set(schema, converted);
  return converted;
};

const emptySchemaPaths = (value: unknown, path = "$"): string[] => {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      emptySchemaPaths(item, `${path}[${String(index)}]`),
    );
  if (typeof value !== "object" || value === null) return [];
  const entries = Object.entries(value);
  if (entries.length === 0) return [path];
  return entries.flatMap(([key, item]) =>
    emptySchemaPaths(item, `${path}.${key}`),
  );
};

describe("tool contract surface", () => {
  it("advertises complete typed schemas and annotations for all analysis tools", () => {
    const contracts = [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
      ...NATIVE_TOOL_CONTRACTS,
      ...ARTIFACT_TOOL_CONTRACTS,
      ...MANAGED_TOOL_CONTRACTS,
      ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
      ...BROWSER_TOOL_CONTRACTS,
      ...ELECTRON_TOOL_CONTRACTS,
      ...APPLICATION_TOOL_CONTRACTS,
    ];
    expect(contracts).toHaveLength(70);
    for (const contract of contracts) {
      const inputSchema = contractJsonSchema(contract.inputSchema);
      const outputSchema = contractJsonSchema(contract.outputSchema);
      expect(inputSchema.type).toBe("object");
      expect(outputSchema.type).toBe("object");
      expect(typeof contract.annotations.idempotentHint).toBe("boolean");
      expect(typeof contract.annotations.openWorldHint).toBe("boolean");
      expect(typeof contract.annotations.readOnlyHint).toBe("boolean");
      expect(typeof contract.annotations.destructiveHint).toBe("boolean");
      expect(contract.examples).toHaveLength(1);
      for (const example of contract.examples) {
        expect(example.title.length).toBeGreaterThan(10);
        expect(contract.inputSchema.safeParse(example.input).success).toBe(
          true,
        );
      }
    }
  });

  it("keeps exactly eighteen additive session contracts", () => {
    expect(
      SESSION_TOOL_CONTRACTS.map(({ name, kind }) => ({ name, kind })),
    ).toEqual([
      { name: "open_binary", kind: "session" },
      { name: "close_binary", kind: "session" },
      { name: "binary_session", kind: "session" },
      { name: "export_evidence_bundle", kind: "session" },
      { name: "import_evidence_bundle", kind: "session" },
      { name: "capture_process_scenario", kind: "session" },
      { name: "compare_process_captures", kind: "session" },
      { name: "compare_artifacts", kind: "session" },
      { name: "compare_functions", kind: "session" },
      { name: "compare_bundles", kind: "session" },
      { name: "find_changed_behavior", kind: "session" },
      { name: "build_call_path", kind: "session" },
      { name: "correlate_static_and_runtime", kind: "session" },
      { name: "verify_reconstruction", kind: "session" },
      { name: "list_unknowns", kind: "session" },
      { name: "record_unknown", kind: "session" },
      { name: "update_unknown", kind: "session" },
      { name: "verify_unknown_resolution", kind: "session" },
    ]);
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

  it("publishes a dedicated output schema and agent guidance for every tool", () => {
    expect(Object.keys(officialOutputSchemas).sort()).toEqual(
      OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    expect(Object.keys(enhancedOutputSchemas).sort()).toEqual(
      ENHANCED_TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    expect(Object.keys(sessionOutputSchemas).sort()).toEqual(
      SESSION_TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    expect(Object.keys(managedOutputSchemas).sort()).toEqual(
      MANAGED_TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    expect(Object.keys(managedWorkflowOutputSchemas).sort()).toEqual(
      MANAGED_WORKFLOW_TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );

    for (const contract of [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
      ...MANAGED_TOOL_CONTRACTS,
      ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
      ...SESSION_TOOL_CONTRACTS,
    ]) {
      const schema = contractJsonSchema(contract.outputSchema);
      expect(JSON.stringify(schema)).not.toContain('"result":{}');
      expect(contract.description.length).toBeGreaterThan(100);
      expect(contract.description).toMatch(/[.;]/u);
    }
  });

  it("publishes no unconstrained output-schema holes across all 88 tools", () => {
    const contracts = [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
      ...NATIVE_TOOL_CONTRACTS,
      ...ARTIFACT_TOOL_CONTRACTS,
      ...MANAGED_TOOL_CONTRACTS,
      ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
      ...BROWSER_TOOL_CONTRACTS,
      ...ELECTRON_TOOL_CONTRACTS,
      ...APPLICATION_TOOL_CONTRACTS,
      ...SESSION_TOOL_CONTRACTS,
    ];
    expect(contracts).toHaveLength(88);
    for (const contract of contracts) {
      const schema = contractJsonSchema(contract.outputSchema);
      expect(emptySchemaPaths(schema), contract.name).toEqual([]);
    }
  });
});
