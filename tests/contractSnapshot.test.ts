import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";
import {
  enhancedOutputSchemas,
  officialOutputSchemas,
  sessionOutputSchemas,
} from "../src/contracts/toolOutputSchemas.js";

describe("tool contract surface", () => {
  it("advertises complete typed schemas and annotations for all analysis tools", () => {
    const contracts = [...OFFICIAL_TOOL_CONTRACTS, ...ENHANCED_TOOL_CONTRACTS];
    expect(contracts).toHaveLength(43);
    for (const contract of contracts) {
      const inputSchema = z.toJSONSchema(contract.inputSchema, {
        target: "draft-07",
        unrepresentable: "any",
      });
      const outputSchema = z.toJSONSchema(contract.outputSchema, {
        target: "draft-07",
        unrepresentable: "any",
      });
      expect(inputSchema.type).toBe("object");
      expect(outputSchema.type).toBe("object");
      expect(contract.annotations).toMatchObject({
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(typeof contract.annotations.readOnlyHint).toBe("boolean");
      expect(typeof contract.annotations.destructiveHint).toBe("boolean");
    }
  });

  it("keeps exactly three additive session contracts", () => {
    expect(
      SESSION_TOOL_CONTRACTS.map(({ name, kind }) => ({ name, kind })),
    ).toEqual([
      { name: "open_binary", kind: "session" },
      { name: "close_binary", kind: "session" },
      { name: "binary_session", kind: "session" },
    ]);
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

    for (const contract of [
      ...OFFICIAL_TOOL_CONTRACTS,
      ...ENHANCED_TOOL_CONTRACTS,
      ...SESSION_TOOL_CONTRACTS,
    ]) {
      const schema = z.toJSONSchema(contract.outputSchema, {
        target: "draft-07",
        unrepresentable: "any",
      });
      expect(JSON.stringify(schema)).not.toContain('"result":{}');
      expect(contract.description.length).toBeGreaterThan(100);
      expect(contract.description).toMatch(/[.;]/u);
    }
  });
});
