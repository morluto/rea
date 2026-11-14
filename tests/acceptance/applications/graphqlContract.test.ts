import { expectCliMcpEvidenceParity } from "../../fixtures/cliMcpEvidenceParity.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { graphqlContractSchema } from "../../../src/domain/apiContract/graphqlContract.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

const fixture = new URL(
  "../../fixtures/graphql/swapi.graphql.txt",
  import.meta.url,
);
const operations =
  "query Films { renamed: allFilms(first: 2) { films { ...Names director } } } fragment Names on Film { title }";
const asView = (value: unknown) =>
  analysisViewResultSchema.parse(parseEvidence(value).normalized_result);
const retained = (parent: Evidence) => ({
  kind: "retained-evidence",
  evidence_id: parent.evidence_id,
});

const checkCliPublication = async (
  cli: TestCli,
  context: {
    root: string;
    parent: Evidence;
    selected: ReturnType<typeof asView>;
  },
) => {
  const { root, parent, selected } = context;
  const run = cli.run.bind(cli);
  const args = [
    "inspect-api-contract",
    "./SDL 雪.graphql",
    "--contractFormat",
    "graphql-sdl",
    "--operationsPath",
    "./queries file.graphql",
  ];
  const cliComplete = await run({
    cwd: root,
    arguments: [...args, "--json"],
  });
  expect(cliComplete.exitCode, cliComplete.stderr).toBe(0);
  expectCliMcpEvidenceParity(cliComplete.json, parent, "./SDL 雪.graphql", {
    operations_path: "./queries file.graphql",
  });
  const bundlePath = join(root, "graphql.evidence.json");
  const cliSelected = await run({
    cwd: root,
    arguments: [
      ...args,
      "--detail",
      "summary",
      "--evidence_output",
      bundlePath,
      "--view",
      JSON.stringify({
        kind: "graphql-contract",
        collection: "fields",
        field_keys: ["Film.title", "Film.director"],
        fields: [],
        limit: 1,
      }),
      "--json",
    ],
  });
  expect(cliSelected.exitCode, cliSelected.stderr).toBe(0);
  const receipt = cliSelected.json as { summary: unknown };
  expect(parseEvidence(receipt.summary)).toMatchObject({
    caller_input_paths: { operations_path: "./queries file.graphql" },
  });
  expect(asView(receipt.summary)).toEqual(selected);
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(await readFile(bundlePath, "utf8")),
  );
  expect(bundle.records[0]?.evidence_id).toBe(parent.evidence_id);
  return bundlePath;
};

type McpCall = Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"];
const checkRetainedPages = async (call: McpCall, parent: Evidence) => {
  const report = graphqlContractSchema.parse(parent.normalized_result);
  const paged = [];
  for (const offset of [0, 100, 200]) {
    const response = await call("inspect_analysis_view", {
      source: retained(parent),
      view: {
        kind: "graphql-contract",
        collection: "fields",
        offset,
        limit: 100,
        fields: [
          "field_id",
          "field_key",
          "owner_type_id",
          "owner_type_name",
          "kind",
          "name",
          "type_ref",
          "named_type",
          "source",
        ],
      },
    });
    const page = asView(response.structuredContent);
    if (page.kind !== "graphql-contract")
      throw new Error("Expected retained GraphQL page");
    expect(page.source_coverage).toEqual(report.source_coverage);
    paged.push(...page.items);
  }
  expect(paged).toEqual(report.fields);
};

const checkAdvertisedSchema = async (
  client: Awaited<ReturnType<typeof connectLocalToolsMcp>>["client"],
  input: { path: string; format: string; operations_path: string },
) => {
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_api_contract",
  );
  expect(schemas.ajv.validate(schemas.inputSchema, input)).toBe(true);
  for (const invalid of [
    { ...input, format: "openapi-json" },
    { ...input, view: { kind: "api-contract", collection: "operations" } },
    {
      ...input,
      view: {
        kind: "graphql-contract",
        collection: "fields",
        fields: ["unknown-column"],
      },
    },
  ])
    expect(schemas.ajv.validate(schemas.inputSchema, invalid)).toBe(false);
};

cliTest(
  "imports unchanged SWAPI SDL through public CLI/MCP with exact bindings, selected replies and source-free retained pages",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-public-graphql-");
    const path = join(root, "SDL 雪.graphql"),
      operationsPath = join(root, "queries file.graphql");
    const bytes = await readFile(fixture);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "ebc4d09b21e2aec2735d6f0d3c812fc017cd49a44900dd3ae34f49f6f8c25133",
    );
    await writeFile(path, bytes);
    await writeFile(operationsPath, operations);
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const input = {
      path,
      format: "graphql-sdl",
      operations_path: operationsPath,
    };
    await checkAdvertisedSchema(client, input);
    const summaryResponse = await call("inspect_api_contract", input);
    expect(summaryResponse.isError).not.toBe(true);
    const summary = asView(summaryResponse.structuredContent);
    expect(summary).toMatchObject({
      kind: "summary",
      summary: {
        model_roots: { query: "Root" },
        summary: {
          types: 53,
          fields: 243,
          definitions: 2,
          references: 4,
          fragment_spreads: 1,
        },
      },
    });
    expect(JSON.stringify(summaryResponse.structuredContent)).not.toContain(
      "Root.allFilms",
    );
    const complete = await call("inspect_api_contract", {
      ...input,
      detail: "complete",
    });
    const parent = parseEvidence(complete.structuredContent);
    const report = graphqlContractSchema.parse(parent.normalized_result);
    expect(summary.parent_evidence_id).toBe(parent.evidence_id);
    expect(
      report.references.map((row) => [
        row.field_name,
        row.parent_type_name,
        row.state,
      ]),
    ).toEqual([
      ["allFilms", "Root", "resolved"],
      ["films", "FilmsConnection", "resolved"],
      ["director", "Film", "resolved"],
      ["title", "Film", "resolved"],
    ]);
    for (const reference of report.references) {
      const field = report.fields.find(
        (row) => row.field_id === reference.schema_field_id,
      )!;
      expect(field.field_key).toBe(
        reference.parent_type_name + "." + reference.field_name,
      );
      expect(
        bytes
          .toString("utf8")
          .slice(field.source.start_utf16, field.source.end_utf16),
      ).toContain(reference.field_name);
      expect(reference.source.sha256).toBe(report.operations_artifact?.sha256);
    }
    const selectedResponse = await call("inspect_api_contract", {
      ...input,
      detail: "complete",
      view: {
        kind: "graphql-contract",
        collection: "fields",
        field_keys: ["Film.title", "Film.director"],
        fields: [],
        limit: 1,
      },
    });
    const selected = asView(selectedResponse.structuredContent);
    expect(selected).toMatchObject({
      kind: "graphql-contract",
      coverage: { total: 2, next_offset: 1 },
      items: [
        {
          field_id: report.fields.find((row) => row.field_key === "Film.title")!
            .field_id,
        },
      ],
    });
    if (selected.kind !== "graphql-contract")
      throw new Error("Expected selected field page");
    expect(Object.keys(selected.items[0]!).sort()).toEqual([
      "field_id",
      "owner_type_id",
      "source",
    ]);
    const bundlePath = await checkCliPublication(cli, {
      root,
      parent,
      selected,
    });
    await rm(path);
    await rm(operationsPath);
    await checkRetainedPages(call, parent);
    const queryPath = join(root, "offline-query.json");
    await writeFile(
      queryPath,
      JSON.stringify({
        source: {
          kind: "evidence-file",
          path: bundlePath,
          evidence_id: parent.evidence_id,
        },
        view: {
          kind: "graphql-contract",
          collection: "fields",
          field_keys: [],
          fields: [],
        },
      }),
    );
    const run = cli.run.bind(cli);
    const offline = await run({
      arguments: ["inspect-analysis-view", queryPath, "--json"],
    });
    expect(offline.exitCode, offline.stderr).toBe(0);
    expect(asView(offline.json)).toMatchObject({
      items: [],
      coverage: { total: 0, exhausted: true },
      source_coverage: report.source_coverage,
    });
  },
);

cliTest(
  "keeps duplicate and malformed GraphQL declarations explicit through advertised public replies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-partial-graphql-");
    const path = join(root, "schema.graphql"),
      operations_path = join(root, "queries.graphql");
    await writeFile(path, "type Query { value: String value: Int }");
    await writeFile(operations_path, "query Q { value ...Missing }");
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const result = await call("inspect_api_contract", {
      path,
      format: "graphql-sdl",
      operations_path,
      detail: "complete",
    });
    const parent = parseEvidence(result.structuredContent);
    const report = graphqlContractSchema.parse(parent.normalized_result);
    expect(report.fields).toHaveLength(2);
    expect(report.references[0]).toMatchObject({
      state: "unknown",
      reason: "schema-model-unavailable",
      schema_field_id: null,
    });
    expect(report.fragment_spreads[0]?.state).toBe("missing");
    expect(report.source_coverage.status).toBe("partial");
    for (const collection of [
      "types",
      "definitions",
      "references",
      "fragment-spreads",
      "diagnostics",
    ]) {
      const response = await call("inspect_analysis_view", {
        source: retained(parent),
        view: { kind: "graphql-contract", collection, fields: [], limit: 1 },
      });
      expect(response.isError).not.toBe(true);
      expect(asView(response.structuredContent)).toMatchObject({
        source_coverage: report.source_coverage,
      });
    }
    await writeFile(operations_path, "query Q { value(");
    const malformed = await call("inspect_api_contract", {
      path,
      format: "graphql-sdl",
      operations_path,
    });
    expect(malformed.isError).not.toBe(true);
    expect(asView(malformed.structuredContent)).toMatchObject({
      summary: {
        source_coverage: { status: "partial", operations: "unavailable" },
      },
    });
    const run = cli.run.bind(cli);
    const cliResult = await run({
      arguments: [
        "inspect-api-contract",
        path,
        "--contractFormat",
        "graphql-sdl",
        "--operationsPath",
        operations_path,
        "--json",
      ],
    });
    expect(cliResult.exitCode, cliResult.stderr).toBe(0);
    expect(
      graphqlContractSchema.parse(
        parseEvidence(cliResult.json).normalized_result,
      ).fields,
    ).toEqual(report.fields);
  },
);

cliTest(
  "retains a primary GraphQL parser refusal for later queries on the same connection",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-invalid-graphql-");
    const path = join(root, "malformed.graphql");
    const text = 'type Query { field: "https://u:p@host/path" }';
    await writeFile(path, text);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const response = await call("inspect_api_contract", {
      path,
      format: "graphql-sdl",
    });
    const error = parseMcpToolError(response);
    const source = error.error.details?.partial_observation;
    expect(source).toMatchObject({ kind: "retained-evidence" });
    expect(JSON.stringify(response)).not.toContain("u:p@host");
    await rm(path);
    const page = await call("inspect_analysis_view", {
      source,
      view: { kind: "graphql-contract", collection: "diagnostics" },
    });
    expect(page.isError).not.toBe(true);
    expect(asView(page.structuredContent)).toMatchObject({
      source_coverage: {
        status: "partial",
        schema_declarations: "unavailable",
      },
      items: [{ code: "schema-parse-refused", source: { role: "schema" } }],
    });
    await writeFile(path, text);
    const run = cli.run.bind(cli);
    const result = await run({
      arguments: [
        "inspect-api-contract",
        path,
        "--contractFormat",
        "graphql-sdl",
        "--json",
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      details: {
        partial_observation: {
          caller_input_path: path,
          operation: "inspect_api_contract",
        },
      },
    });
  },
);
