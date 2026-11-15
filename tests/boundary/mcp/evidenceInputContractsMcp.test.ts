import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES } from "../../../src/config/mcpInputSchemaProfile.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { advertisedInputJsonSchema } from "../../../src/contracts/toolSchemaMetadata.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { advertisedSchemaErrors } from "../../fixtures/mcpAdvertisedSchemaValidity.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

describe("Evidence input SDK boundaries", () => {
  it("borrows SDK Evidence inputs while leaving ordinary request constraints active", async () => {
    const contract = toolContract("build_call_path");
    const registration = toolRegistrationOptions(contract);
    const source = Object.defineProperty({}, "normalized_result", {
      get: () => {
        throw new Error("SDK must not clone the unadmitted payload");
      },
    });
    const input = {
      functions: [source],
      start: { address: "0x1000" },
      goal: { address: "0x1001" },
    };
    const validated =
      await registration.inputSchema["~standard"].validate(input);
    expect(validated.issues).toBeUndefined();
    if (validated.issues !== undefined) throw new Error("valid frame rejected");
    expectTypeOf(validated.value.functions[0]).toBeUnknown();
    expect(validated.value.functions[0]).toBe(source);
    const invalid = await registration.inputSchema["~standard"].validate({
      ...input,
      start: { address: 1 },
    });
    expect(invalid.issues).toBeDefined();
  });

  it("advertises the Evidence union for described borrowed inputs", () => {
    // `.describe()` rebuilds a schema from its definition; the borrowed
    // declaration must survive it rather than advertise an unconstrained value.
    const contract = SESSION_TOOL_CONTRACTS.find(
      (item) => item.name === "match_native_functions",
    );
    if (contract === undefined)
      throw new Error("Missing match_native_functions contract");
    const properties = advertisedInputJsonSchema(contract).properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const name of ["left", "right"]) {
      const property = properties[name];
      expect(property?.description, name).toBe(
        `${name === "left" ? "Left" : "Right"} list_procedures Evidence or exact retained reference`,
      );
      const branches = property?.anyOf ?? property?.oneOf;
      expect(Array.isArray(branches), name).toBe(true);
      expect(JSON.stringify(branches)).toContain('"retained-evidence"');
    }
    expect(properties.left_observations).toMatchObject({ type: "array" });
  });

  mcpTest.for(["full", "compact"] as const)(
    "advertises valid reference inputs after actual SDK conversion (%s)",
    async (profile, { mcp }) => {
      const contract = toolContract("build_call_path");
      const server = new EvidenceMcpServer(
        { name: "evidence-contract", version: "1" },
        { capabilities: {} },
        undefined,
        createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
        profile === "compact"
          ? { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES }
          : undefined,
      );
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({ content: [] }),
      );
      const client = await mcp.connect(server, {
        name: "evidence-contract",
        version: "1",
      });
      const { tools } = await client.listTools();
      expect(advertisedSchemaErrors(tools)).toEqual([]);
      const tool = tools.find(({ name }) => name === contract.name);
      if (tool === undefined) throw new Error("named contract not advertised");
      // Compact input guidance is part of the tool description.
      const guidance =
        profile === "compact" ? tool.description : tool.inputSchema.description;
      expect(guidance).toContain(
        '{"kind":"retained-evidence","evidence_id":"ev_..."}',
      );
      expect(guidance).toContain("parent_evidence_id");
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(tool.inputSchema);
      expect(
        validate({
          functions: [
            {
              kind: "retained-evidence",
              evidence_id: `ev_${"a".repeat(64)}`,
            },
          ],
          start: { address: "0x1000" },
          goal: { address: "0x1001" },
        }),
        JSON.stringify(validate.errors),
      ).toBe(true);
    },
  );
});
