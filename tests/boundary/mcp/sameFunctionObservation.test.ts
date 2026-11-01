import { afterAll, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";

const example = FUNCTION_COMPARISON_EXAMPLE.left;
const dossier = functionDossierSchema.parse(example.normalized_result);
const { symbol: _symbol, ...procedure } = dossier.procedure;
const observation = (request: string) =>
  createEvidence(
    { path: "/tmp/fixture", sha256: "0".repeat(64), format: "mach-o" },
    example.provider,
    {
      operation: "analyze_function",
      parameters: { procedure: request },
      result: {
        ...dossier,
        procedure,
        comments: [],
        facet_availability: {
          ...dossier.facet_availability,
          comments: { available: false, reason: "Fixture has no comments." },
        },
      },
      confidence: "derived",
      authority: "shipped-artifact",
      relationshipCoverage: { status: "complete" },
    },
  );
const main = observation("main");
const another = observation("another-selector");
const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());
const ref = (evidence_id: string) => ({
  kind: "retained-evidence",
  evidence_id,
});

it.each(["full", "compact"] as const)(
  "compares the same authenticated observation while preserving incomplete facets (%s)",
  async (profile) => {
    const session = createTestBinarySession(() => {
      throw new Error("offline comparison must not launch a provider");
    });
    expect(session.recordEvidence(main).ok).toBe(true);
    expect(session.recordEvidence(another).ok).toBe(true);
    const { client } = await createApplicationMcpHarness({
      session,
      schemaValidator: schemaValidation,
      serverOptions: {
        environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    });
    const schema = (await client.listTools()).tools.find(
      ({ name }) => name === "compare_functions",
    )?.outputSchema;
    if (schema === undefined) throw new Error("Missing output schema");
    const reply = await client.callTool({
      name: "compare_functions",
      arguments: { left: ref(main.evidence_id), right: ref(main.evidence_id) },
    });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    expect(
      new Ajv2020({ strict: false }).validate(
        schema as AnySchema,
        reply.structuredContent,
      ),
    ).toBe(true);
    const result = parseEvidence(reply.structuredContent).normalized_result;
    expect(result).toMatchObject({
      status: "unknown",
      function_match: { status: "matched", method: "same-evidence" },
      dimensions: expect.arrayContaining([
        expect.objectContaining({ dimension: "identity", status: "unchanged" }),
        expect.objectContaining({ dimension: "comments", status: "unknown" }),
      ]),
    });
    const comparison = parseEvidence(reply.structuredContent);
    const behavior = await client.callTool({
      name: "find_changed_behavior",
      arguments: { comparisons: [ref(comparison.evidence_id)] },
    });
    expect(behavior.isError, JSON.stringify(behavior.content)).not.toBe(true);
    const behaviorResult = parseEvidence(
      behavior.structuredContent,
    ).normalized_result;
    expect(behaviorResult).toMatchObject({
      behavior_status: "unknown",
      findings: {
        items: expect.arrayContaining([
          expect.objectContaining({ dimension: "comments", status: "unknown" }),
        ]),
      },
    });
    expect(behaviorResult).toMatchObject({
      findings: {
        items: expect.not.arrayContaining([
          expect.objectContaining({ dimension: "identity" }),
        ]),
      },
    });
    const contradictory = createEvidence(undefined, comparison.provider, {
      predicateType: comparison.predicate_type,
      operation: comparison.operation,
      parameters: {
        left_evidence_id: main.evidence_id,
        right_evidence_id: another.evidence_id,
      },
      result: comparison.normalized_result,
      confidence: comparison.confidence,
      authority: comparison.authority,
      limitations: comparison.limitations,
      evidenceLinks: [main.evidence_id, another.evidence_id],
    });
    const contradictoryBehavior = await client.callTool({
      name: "find_changed_behavior",
      arguments: { comparisons: [contradictory] },
    });
    expect(contradictoryBehavior.isError).toBe(true);
    expect(parseMcpToolError(contradictoryBehavior).error.code).toBe(
      "evidence_integrity_mismatch",
    );
    const distinct = await client.callTool({
      name: "compare_functions",
      arguments: {
        left: ref(main.evidence_id),
        right: ref(another.evidence_id),
      },
    });
    expect(
      parseEvidence(distinct.structuredContent).normalized_result,
    ).toMatchObject({
      function_match: { status: "ambiguous" },
    });
    const rebound = await client.callTool({
      name: "compare_functions",
      arguments: {
        left: main,
        right: { ...main, caller_input_path: "/tmp/alternate-spelling" },
      },
    });
    expect(
      parseEvidence(rebound.structuredContent).normalized_result,
    ).toMatchObject({
      function_match: { status: "matched", method: "same-evidence" },
    });
    const tampered = await client.callTool({
      name: "compare_functions",
      arguments: {
        left: ref(main.evidence_id),
        right: { ...main, normalized_result: { ...dossier, procedure } },
      },
    });
    expect(tampered.isError).toBe(true);
    expect(parseMcpToolError(tampered).error.code).toBe(
      "evidence_integrity_mismatch",
    );
  },
);
