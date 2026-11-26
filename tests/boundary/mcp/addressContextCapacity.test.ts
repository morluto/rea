import { expect } from "vitest";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { inspectCapacityContext } from "../../support/mcp/addressContextCapacity.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest.for(["compact"] as const)(
  "preserves retained siblings and capacity recovery (%s schema)",
  async (profile, { mcp, onTestFinished }) => {
    const { call, address, response, records, session } =
      await inspectCapacityContext(
        mcp,
        onTestFinished,
        { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
        { procedureName: "f".repeat(16000) },
      );
    const contract = SESSION_TOOL_CONTRACTS.find(
      (
        candidate,
      ): candidate is Extract<
        (typeof SESSION_TOOL_CONTRACTS)[number],
        { readonly name: "inspect_address_context" }
      > => candidate.name === "inspect_address_context",
    );
    if (contract === undefined)
      throw new Error("inspect_address_context contract is missing");
    const context = contract.outputSchema.parse(
      response.structuredContent,
    ).result;
    const direct = await call("resolve_containing_procedure", address);
    expect(direct.isError).toBe(true);
    const expected = parseMcpToolError(direct).error;
    expect(expected.code).toBe("resource_constraint");
    expect(expected.details).toMatchObject({
      partial_observation: {
        kind: "unretained-evidence",
        evidence: {
          operation: "resolve_containing_procedure",
          normalized_result: { found: true, query_address: "0x100" },
        },
      },
    });
    expect(context.name).toEqual({ state: "available", value: "entry" });
    expect(context.procedure).toEqual({
      state: "unavailable",
      reason: expected.message,
      remediation: expected.remediation.action,
      error: expected,
    });
    expect(records.statistics().evidenceRecords).toBe(1);
    expect(session.immutableEvidenceBundle().records[0]).toMatchObject({
      operation: "address_name",
      normalized_result: "entry",
    });
  },
);
