import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { afterAll, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE } from "../../../src/contracts/javascript/javascriptExportShapeComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());
const retained = (evidence_id: string) => ({
  kind: "retained-evidence",
  evidence_id,
});
const application = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
const pair = JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE;
const exportPair = JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE;

async function connect() {
  const session = createTestBinarySession(() => {
    throw new Error("references must not launch a provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "retained-evidence-test", version: "1" },
    schemaValidator: schemaValidation,
    serverOptions: {
      environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    },
  });
  return { client, session };
}

it("advertises semantic discovery paging and validates the returned Evidence", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "trace_application_feature");
  if (tool === undefined)
    throw new Error("Missing feature trace output schema");
  const input = {
    application,
    seed: { kind: "string", value: "missing-semantic-name", match: "exact" },
    semantic_page: { offset: 0, limit: 1 },
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const outputSchema = canonicalOutputSchema(tool.name) as AnySchema;
  expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(ajv.compile(tool.inputSchema)(input)).toBe(true);
  const result = await client.callTool({ name: tool.name, arguments: input });
  expect(result.isError).not.toBe(true);
  expect(ajv.compile(outputSchema)(result.structuredContent)).toBe(true);
  expect(result.structuredContent).toMatchObject({
    normalized_result: { semantic_discovery: { total: 0, next_offset: null } },
  });
});

it("advertises and uses primitive literal seeds for semantic tracing", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "trace_javascript_semantics");
  if (tool === undefined) throw new Error("Semantic trace tool is missing");
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(tool.inputSchema);
  const request = (value: unknown) => ({
    name: tool.name,
    arguments: {
      application,
      query: {
        seed: { kind: "literal", value },
        direction: "backward-provenance",
      },
    },
  });
  for (const value of ["literal", 42, true, null]) {
    const input = request(value);
    expect(validate(input.arguments), JSON.stringify(value)).toBe(true);
    const result = await client.callTool(input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      parameters: { query: { seed: { kind: "literal", value } } },
    });
  }
  for (const value of [{}, []])
    expect(
      parseMcpToolError(await client.callTool(request(value))).error,
    ).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["query", "seed", "value"] }),
        ]),
      },
    });
});

it("runs the same trace/compare workflows with inline and retained application Evidence", async () => {
  const { client, session } = await connect();
  expect(session.recordEvidence(pair.left).ok).toBe(true);
  expect(session.recordEvidence(pair.right).ok).toBe(true);
  expect(session.recordEvidence(exportPair.left).ok).toBe(true);
  expect(session.recordEvidence(exportPair.right).ok).toBe(true);
  const scenarios = [
    {
      name: "trace_application_feature",
      inline: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      refs: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
        application: retained(application.evidence_id),
      },
    },
    {
      name: "compare_application_versions",
      inline: pair,
      refs: {
        left: retained(pair.left.evidence_id),
        right: retained(pair.right.evidence_id),
      },
      mixed: { left: pair.left, right: retained(pair.right.evidence_id) },
    },
    {
      name: "compare_javascript_export_shapes",
      inline: JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
      refs: {
        ...JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
        left: retained(exportPair.left.evidence_id),
        right: retained(exportPair.right.evidence_id),
      },
    },
    {
      name: "compare_source_to_bundle",
      inline: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
      refs: {
        ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
        application: retained(application.evidence_id),
      },
    },
    {
      name: "trace_javascript_semantics",
      inline: {
        application,
        query: {
          seed: { kind: "literal", value: true },
          direction: "backward-provenance",
        },
      },
      refs: {
        application: retained(application.evidence_id),
        query: {
          seed: { kind: "literal", value: true },
          direction: "backward-provenance",
        },
      },
    },
  ];
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const { tools } = await client.listTools();
  for (const scenario of scenarios) {
    const tool = tools.find(({ name }) => name === scenario.name);
    if (tool === undefined) throw new Error("missing advertised tool");
    expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
    const validate = ajv.compile(tool.inputSchema);
    expect(validate(scenario.inline), scenario.name).toBe(true);
    const inline = await client.callTool({
      name: scenario.name,
      arguments: scenario.inline,
    });
    expect(inline.isError, scenario.name).not.toBe(true);
    const recordsBefore = session.exportEvidenceBundle().records;
    for (const input of [
      scenario.refs,
      ...("mixed" in scenario ? [scenario.mixed] : []),
    ]) {
      expect(validate(input), scenario.name).toBe(true);
      const referenced = await client.callTool({
        name: scenario.name,
        arguments: input,
      });
      expect(referenced.isError, scenario.name).not.toBe(true);
      expect(referenced.structuredContent, scenario.name).toEqual(
        inline.structuredContent,
      );
      expect(session.exportEvidenceBundle().records, scenario.name).toEqual(
        recordsBefore,
      );
    }
  }
});

it("keeps references connection-scoped through close and expires them on explicit investigation reset", async () => {
  const first = await connect();
  const second = await connect();
  expect(first.session.recordEvidence(application).ok).toBe(true);
  const request = {
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      application: retained(application.evidence_id),
    },
  };
  const foreign = await second.client.callTool(request);
  expect(parseMcpToolError(foreign)).toMatchObject({
    error: {
      details: {
        evidence_id: application.evidence_id,
        reason: "missing",
        actual: null,
      },
    },
  });
  const bundle = first.session.exportEvidenceBundle();
  expect(second.session.importEvidenceBundle(bundle).ok).toBe(true);
  expect((await second.client.callTool(request)).isError).not.toBe(true);
  const closed = await first.client.callTool({
    name: "close_binary",
    arguments: {},
  });
  expect(closed.isError).not.toBe(true);
  expect((await first.client.callTool(request)).isError).not.toBe(true);
  const reset = await first.client.callTool({
    name: "reset_investigation",
    arguments: {},
  });
  expect(reset.isError).not.toBe(true);
  expect(parseMcpToolError(await first.client.callTool(request))).toMatchObject(
    { error: { details: { reason: "missing" } } },
  );
  for (const harness of [first, second]) {
    const portable = await harness.client.callTool({
      name: "trace_application_feature",
      arguments: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    });
    expect(portable.isError).not.toBe(true);
    expect((await harness.client.callTool(request)).structuredContent).toEqual(
      portable.structuredContent,
    );
  }
});

it("preserves validation for the referenced record's operation, predicate, and semantic identity", async () => {
  const { client, session } = await connect();
  for (const record of [
    createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "inventory_artifact", parameters: {}, result: {} },
    ),
    createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "analyze_javascript_application",
        predicateType: "wrong-predicate",
        parameters: {},
        result: {},
      },
    ),
  ]) {
    expect(session.recordEvidence(record).ok).toBe(true);
    const response = await client.callTool({
      name: "trace_application_feature",
      arguments: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
        application: retained(record.evidence_id),
      },
    });
    expect(parseMcpToolError(response)).toMatchObject({
      error: { code: "invalid_request", category: "invalid_input" },
    });
  }
  for (const reference of [
    { evidence_id: application.evidence_id },
    { ...retained(application.evidence_id), kind: "another-session" },
    retained("ev_short"),
    { ...retained(application.evidence_id), session_id: "foreign" },
    { ...retained(application.evidence_id), normalized_result: {} },
  ]) {
    const rejected = await client.callTool({
      name: "trace_application_feature",
      arguments: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
        application: reference,
      },
    });
    expect(rejected.isError).toBe(true);
  }
  const tampered = {
    ...application,
    provider: { ...application.provider, id: "tampered" },
  };
  expect(() => parseEvidence(tampered)).toThrow();
  expect(session.recordEvidence(tampered).ok).toBe(false);
  const response = await client.callTool({
    name: "trace_application_feature",
    arguments: { ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE, application: tampered },
  });
  expect(response.isError).toBe(true);
});

it("projects a retained JavaScript summary without graph or semantic_graph", async () => {
  const { client, session } = await connect();
  expect(session.recordEvidence(application).ok).toBe(true);
  const inline = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: application },
      view: { kind: "summary" },
    },
  });
  const referenced = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: retained(application.evidence_id),
      view: { kind: "summary" },
    },
  });
  expect(inline.isError).not.toBe(true);
  expect(referenced.structuredContent).toEqual(inline.structuredContent);
  expect(inline.structuredContent).not.toHaveProperty(
    "normalized_result.summary.semantic_graph",
  );
});
