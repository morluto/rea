import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { apiContractSchema } from "../../../src/domain/apiContract/apiContract.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

type McpCall = Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"];
const fixture = new URL(
  "../../fixtures/openapi/petstore.json.txt",
  import.meta.url,
);
const asView = (response: Awaited<ReturnType<McpCall>>) => {
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  return analysisViewResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
};
const retained = (evidence: Evidence) => ({
  kind: "retained-evidence",
  evidence_id: evidence.evidence_id,
});

const checkRetainedPages = async (call: McpCall, parent: Evidence) => {
  const report = apiContractSchema.parse(parent.normalized_result);
  const rows = [];
  for (let offset = 0; offset < 19; offset += 5) {
    const page = asView(
      await call("inspect_analysis_view", {
        source: retained(parent),
        view: {
          kind: "api-contract",
          collection: "operations",
          offset,
          limit: 5,
        },
      }),
    );
    expect(page.kind).toBe("api-contract");
    if (page.kind !== "api-contract")
      throw new Error("Expected operation page");
    rows.push(...page.items);
    expect(page.source_coverage).toEqual(report.source_coverage);
    expect(page.coverage.exhausted).toBe(offset + 5 >= 19);
  }
  expect(rows).toEqual(report.operations);
  const selected = asView(
    await call("inspect_analysis_view", {
      source: retained(parent),
      view: {
        kind: "api-contract",
        collection: "operations",
        paths: ["/pet/{petId}"],
        methods: ["GET"],
        fields: [],
      },
    }),
  );
  expect(selected.kind).toBe("api-contract");
  if (selected.kind !== "api-contract")
    throw new Error("Expected selected page");
  expect(selected.items).toHaveLength(1);
  expect(Object.keys(selected.items[0]!).sort()).toEqual([
    "operation_id",
    "operation_key",
    "reason",
    "source_pointer",
    "state",
  ]);
  const wanted = report.operations.find(
    (row) => row.declared_id === "getPetById",
  )!;
  expect(selected.items[0]).toMatchObject({
    operation_id: wanted.operation_id,
    operation_key: wanted.operation_key,
    state: "declared",
  });
  for (const filter of [
    { operation_ids: [] },
    { methods: [] },
    { paths: [] },
    { declared_ids: [] },
  ]) {
    const empty = asView(
      await call("inspect_analysis_view", {
        source: retained(parent),
        view: { kind: "api-contract", collection: "operations", ...filter },
      }),
    );
    expect(empty).toMatchObject({
      items: [],
      coverage: { total: 0, exhausted: true },
      source_coverage: report.source_coverage,
    });
  }
  const batch = asView(
    await call("inspect_analysis_view", {
      source: retained(parent),
      view: {
        kind: "api-contract",
        collection: "operations",
        operation_keys: report.operations
          .slice(0, 2)
          .map((row) => row.operation_key),
      },
    }),
  );
  expect(batch).toMatchObject({
    items: report.operations.slice(0, 2),
    coverage: { total: 2 },
  });
};

const checkCliPublication = async (
  cli: TestCli,
  context: {
    root: string;
    path: string;
    parent: Evidence;
    summary: unknown;
    selected: unknown;
  },
) => {
  const { root, path, parent, summary, selected } = context;
  const run = cli.run.bind(cli);
  const complete = await run({
    arguments: ["inspect-api-contract", path, "--json"],
  });
  expect(complete.exitCode, complete.stderr).toBe(0);
  expect(parseEvidence(complete.json)).toEqual({
    ...parent,
    caller_input_path: path,
  });
  const bundlePath = join(root, "contract.bundle.json");
  const receipt = await run({
    arguments: [
      "inspect-api-contract",
      path,
      "--detail",
      "summary",
      "--evidence_output",
      bundlePath,
      "--json",
    ],
  });
  expect(receipt.exitCode, receipt.stderr).toBe(0);
  expect(receipt.json).toMatchObject({
    summary: { ...parseEvidence(summary), caller_input_path: path },
  });
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(await readFile(bundlePath, "utf8")),
  );
  expect(bundle.records).toEqual([{ ...parent, caller_input_path: path }]);
  const request = {
    kind: "api-contract",
    collection: "operations",
    methods: ["GET"],
    limit: 2,
  };
  const inline = await run({
    arguments: [
      "inspect-api-contract",
      path,
      "--detail",
      "summary",
      "--view",
      JSON.stringify(request),
      "--evidence_output",
      join(root, "selected.bundle.json"),
      "--json",
    ],
  });
  expect(inline.exitCode, inline.stderr).toBe(0);
  expect(inline.json).toMatchObject({
    summary: { ...parseEvidence(selected), caller_input_path: path },
  });
  const viewInput = join(root, "retained-page.json");
  await writeFile(
    viewInput,
    JSON.stringify({
      source: {
        kind: "evidence-file",
        path: bundlePath,
        evidence_id: parent.evidence_id,
      },
      view: request,
    }),
  );
  await rm(path);
  const fromBundle = await run({
    arguments: ["inspect-analysis-view", viewInput, "--json"],
  });
  expect(fromBundle.exitCode, fromBundle.stderr).toBe(0);
  expect(parseEvidence(fromBundle.json)).toEqual(parseEvidence(selected));
  const missingSink = await run({
    arguments: ["inspect-api-contract", path, "--detail", "summary", "--json"],
  });
  expect(missingSink.json).toMatchObject({ code: "invalid_request" });
  const invalidView = await run({
    arguments: [
      "inspect-api-contract",
      path,
      "--view",
      JSON.stringify(request),
      "--json",
    ],
  });
  expect(invalidView.json).toMatchObject({ code: "invalid_request" });
};

cliTest(
  "imports the published OpenAPI document through public CLI/MCP with retained, selected and complete parity",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-public-api-contract-");
    const path = join(root, "openapi.json");
    const bytes = await readFile(fixture);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "00441c05add60f28da55eb4563d3fb6bbda364ba8eb7b381e2e2c98613005c82",
    );
    await writeFile(path, bytes);
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const schemas = await advertisedMcpToolSchemas(
      client,
      "inspect_api_contract",
    );
    expect(schemas.ajv.validate(schemas.inputSchema, { path })).toBe(true);
    expect(
      schemas.ajv.validate(schemas.inputSchema, {
        path,
        view: {
          kind: "api-contract",
          collection: "operations",
          fields: ["not-a-field"],
        },
      }),
    ).toBe(false);
    const summary = await call("inspect_api_contract", { path });
    const summaryView = asView(summary);
    expect(summaryView).toMatchObject({
      kind: "summary",
      summary: { summary: { operation_slots: 19, declared: 19, unknown: 0 } },
    });
    expect(JSON.stringify(summary.structuredContent)).not.toContain(
      "getPetById",
    );
    const bundle = await call("get_evidence_bundle", { detail: "complete" });
    expect(bundle.isError).not.toBe(true);
    const records = z
      .object({ result: evidenceBundleSchema })
      .parse(bundle.structuredContent).result.records;
    const parent = records.find(
      (record) => record.evidence_id === summaryView.parent_evidence_id,
    )!;
    expect(parent).toBeDefined();
    expect(
      apiContractSchema.parse(parent.normalized_result).summary.declared,
    ).toBe(19);
    const full = await call("inspect_api_contract", {
      path,
      detail: "complete",
    });
    expect(parseEvidence(full.structuredContent)).toEqual(parent);
    const selected = await call("inspect_api_contract", {
      path,
      detail: "complete",
      view: {
        kind: "api-contract",
        collection: "operations",
        methods: ["GET"],
        limit: 2,
      },
    });
    expect(asView(selected)).toMatchObject({
      kind: "api-contract",
      items: [{ method: "GET" }, { method: "GET" }],
    });
    await rm(path);
    await checkRetainedPages(call, parent);
    await writeFile(path, bytes);
    await checkCliPublication(cli, {
      root,
      path,
      parent,
      summary: summary.structuredContent,
      selected: selected.structuredContent,
    });
    expect((await readFile(fixture)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "keeps unresolved references, malformed siblings and partial coverage offline",
  async ({ cli }) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    onTestFinished(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected loopback listener");
    const reference = `http://127.0.0.1:${address.port}/never-requested.json`;
    const root = await createTestTempDirectory("rea-partial-api-contract-");
    const path = join(root, "partial.json");
    const value = JSON.parse((await readFile(fixture)).toString("utf8"));
    value.paths["/remote"] = { $ref: reference };
    value.paths["/pet"].$ref = "#/paths/~1pet";
    value.paths["/broken"] = { get: null };
    value.servers = [{ url: reference }];
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const complete = await call("inspect_api_contract", {
      path,
      detail: "complete",
    });
    expect(complete.isError).not.toBe(true);
    const parent = parseEvidence(complete.structuredContent);
    const report = apiContractSchema.parse(parent.normalized_result);
    expect(report.summary).toEqual({
      operation_slots: 20,
      declared: 17,
      unknown: 3,
      unresolved_path_items: 2,
      diagnostics: 1,
    });
    const source = retained(parent);
    const refs = asView(
      await call("inspect_analysis_view", {
        source,
        view: {
          kind: "api-contract",
          collection: "path-item-references",
          limit: 64,
        },
      }),
    );
    expect(refs).toMatchObject({
      items: [{ reference: "#/paths/~1pet" }, { reference }],
      coverage: { exhausted: true },
      source_coverage: { status: "partial" },
    });
    const diagnostics = asView(
      await call("inspect_analysis_view", {
        source,
        view: {
          kind: "api-contract",
          collection: "diagnostics",
          codes: ["invalid-operation"],
        },
      }),
    );
    expect(diagnostics).toMatchObject({
      items: [
        { code: "invalid-operation", source_pointer: "/paths/~1broken/get" },
      ],
      source_coverage: { status: "partial" },
    });
    const unknown = asView(
      await call("inspect_api_contract", {
        path,
        view: {
          kind: "api-contract",
          collection: "operations",
          states: ["unknown"],
        },
      }),
    );
    expect(unknown).toMatchObject({
      coverage: { total: 3 },
      source_coverage: { status: "partial" },
    });
    const run = cli.run.bind(cli);
    const cliResult = await run({
      arguments: ["inspect-api-contract", path, "--json"],
    });
    expect(cliResult.exitCode, cliResult.stderr).toBe(0);
    expect(parseEvidence(cliResult.json)).toEqual({
      ...parent,
      caller_input_path: path,
    });
    const unsupported = join(root, "unsupported.json");
    await writeFile(unsupported, JSON.stringify({ ...value, openapi: "2.0" }));
    const refused = parseMcpToolError(
      await call("inspect_api_contract", { path: unsupported }),
    );
    expect(refused.error.code).toBe("unsupported_target");
    expect(refused.error.details?.partial_observation).toMatchObject({
      kind: "file-snapshot-hash",
      path: unsupported,
    });
    expect(requests).toBe(0);
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);

cliTest(
  "preserves verified failure identity without exposing malformed JSON source through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-invalid-api-contract-");
    const path = join(root, "malformed.json");
    const bytes = '{"$ref":"https://u:p@h","":NaN}';
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application",
    });
    const response = await call("inspect_api_contract", { path });
    const error = parseMcpToolError(response);
    const snapshot = {
      kind: "file-snapshot-hash",
      path,
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(error.error).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: snapshot },
    });
    expect(JSON.stringify(response)).not.toContain("u:p@h");
    const run = cli.run.bind(cli);
    const result = await run({
      arguments: ["inspect-api-contract", path, "--json"],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { partial_observation: snapshot },
    });
    expect(result.stdout + result.stderr).not.toContain("u:p@h");
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);
