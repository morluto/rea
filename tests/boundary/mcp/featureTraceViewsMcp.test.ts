import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { JAVASCRIPT_FEATURE_TRACE_EXAMPLE } from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

type Trace = z.output<typeof applicationFeatureTraceResultSchema>;
type Row = Record<string, unknown>;

const CHANNELS = ["save-0", "save-1", "save-2"];

/** A small Electron application whose IPC handlers reach storage and network endpoints. */
const writeApplication = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-feature-trace-view-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "trace-view", version: "1.0.0", main: "main.js" }),
    ),
    writeFile(
      join(root, "main.js"),
      [
        'const {app,BrowserWindow,ipcMain}=require("electron");',
        'const fs=require("fs");',
        ...CHANNELS.map(
          (channel) =>
            `ipcMain.handle("${channel}",async(event,value)=>{fs.writeFileSync("/tmp/${channel}",value);return fetch("https://api.example.test/${channel}");});`,
        ),
        'app.whenReady().then(()=>new BrowserWindow({webPreferences:{preload:"./preload.js"}}));',
      ].join("\n"),
    ),
    writeFile(
      join(root, "preload.js"),
      `const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("api",{${CHANNELS.map(
        (channel, index) =>
          `save${String(index)}:(value)=>ipcRenderer.invoke("${channel}",value)`,
      ).join(",")}});`,
    ),
    writeFile(join(root, "index.html"), "<!doctype html><html></html>\n"),
  ]);
  return root;
};

const connect = async (
  profile: "full" | "compact",
  maximumResponseBytes?: number,
) => {
  const application = await analyzeJavaScriptApplication({
    input_path: await writeApplication(),
  });
  if (!application.ok) throw application.error;
  const session = createTestBinarySession(() => {
    throw new Error("Feature trace views must not open a native provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "feature-trace-view", version: "1" },
    schemaValidator: schemaValidation,
    serverOptions: {
      environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: profile },
      ...(maximumResponseBytes === undefined
        ? {}
        : { delivery: createToolResultDelivery(maximumResponseBytes) }),
    },
  });
  expect(session.recordEvidence(application.value).ok).toBe(true);
  const inputs = {
    application: {
      kind: "retained-evidence",
      evidence_id: application.value.evidence_id,
    },
    seed: { kind: "channel", value: "save-0", match: "exact" },
    direction: "both",
  };
  const reply = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return { evidence: parseEvidence(result.structuredContent), result };
  };
  return { client, session, inputs, reply, call };
};

const traced = (evidence: Evidence): Trace =>
  applicationFeatureTraceResultSchema.parse(evidence.normalized_result);

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

type Harness = Awaited<ReturnType<typeof connect>>;

it.each(["full", "compact"] as const)(
  "returns selected feature-trace facts and retains the complete trace (%s)",
  async (profile) => {
    const harness = await connect(profile);
    const { client, session, inputs, call } = harness;
    // Select first: the view call alone must retain the complete parent.
    const summary = await call("trace_application_feature", {
      ...inputs,
      view: { kind: "summary" },
    });
    const parentId = z
      .object({ parent_evidence_id: z.string() })
      .parse(summary.evidence.normalized_result).parent_evidence_id;
    const retained = session.evidenceById(parentId);
    const complete = await call("trace_application_feature", inputs);
    const parent = complete.evidence;
    expect(parent.evidence_id).toBe(parentId);
    expect(retained).toEqual(parent);
    const full = traced(parent);
    const graph = full.graph!;
    expect(full.paths.length).toBeGreaterThan(1);
    expect(graph.edges.length).toBeGreaterThan(graph.nodes.length);
    expect(summary.evidence.confidence).toBe(parent.confidence);
    expect(summary.evidence.normalized_result).toMatchObject({
      kind: "summary",
      parent_operation: "trace_application_feature",
      artifact: null,
      summary: {
        trace_id: full.trace_id,
        source_evidence_id: full.source_evidence_id,
        seed: full.seed,
        summary: full.summary,
        trace_coverage: full.coverage,
        graph_coverage: graph.coverage,
        evidence_links: full.evidence_links,
      },
      coverage: { status: "complete-within-view", exhausted: true },
    });
    expect(bytes(summary.result)).toBeLessThan(bytes(complete.result) / 10);

    const { tools } = await client.listTools();
    const ajv = schemaValidation.assertions;
    const traceTool = tools.find(
      ({ name }) => name === "trace_application_feature",
    )!;
    expect(ajv.validateSchema(traceTool.inputSchema)).toBe(true);
    const outputSchema: Record<string, unknown> = traceTool.outputSchema!;
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const request = {
      kind: "feature-trace",
      collection: "paths",
      where: { end_kinds: ["endpoint"] },
      limit: 2,
    };
    expect(
      ajv.validate(traceTool.inputSchema, { ...inputs, view: request }),
    ).toBe(true);
    const selected = await call("trace_application_feature", {
      ...inputs,
      view: request,
    });
    for (const evidence of [summary.evidence, selected.evidence])
      expect(ajv.validate(outputSchema, evidence)).toBe(true);
    const endpointPaths = full.paths.filter(
      ({ end_kind }) => end_kind === "endpoint",
    );
    expect(endpointPaths.length).toBeGreaterThan(2);
    expect(selected.evidence.normalized_result).toMatchObject({
      kind: "feature-trace",
      parent_evidence_id: parent.evidence_id,
      trace_id: full.trace_id,
      trace_coverage: full.coverage,
      items: endpointPaths.slice(0, 2),
      coverage: { total: endpointPaths.length, next_offset: 2 },
    });
    await assertRetainedTracePages(harness, parent.evidence_id, full);
  },
);

/** Page the retained parent through inspect_analysis_view without re-running the trace. */
const assertRetainedTracePages = async (
  { call, reply }: Harness,
  parentId: string,
  full: Trace,
) => {
  const graph = full.graph!;
  const source = { kind: "retained-evidence", evidence_id: parentId };
  const view = async (selection: Record<string, unknown>) => {
    const page = analysisViewResultSchema.parse(
      (await call("inspect_analysis_view", { source, view: selection }))
        .evidence.normalized_result,
    );
    if (page.kind !== "feature-trace") throw new Error("Expected trace page");
    return page;
  };
  // Successive small pages reproduce each complete collection in retained order.
  const collect = async (selection: Record<string, unknown>) => {
    const rows: Row[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await view({
        kind: "feature-trace",
        ...selection,
        offset,
        limit: 7,
      });
      rows.push(...(page.items as Row[]));
      offset = page.coverage.next_offset;
    }
    return rows;
  };
  const ids = (rows: readonly Row[] | readonly { node_id: string }[]) =>
    rows.map(({ node_id: id }) => id);
  const seeds = new Set(ids(full.seed_matches));
  expect(await collect({ collection: "paths" })).toEqual(full.paths);
  expect(await collect({ collection: "edges" })).toEqual(graph.edges);
  expect(await collect({ collection: "seed_matches" })).toEqual(
    full.seed_matches,
  );
  expect(await collect({ collection: "native_handoffs" })).toEqual([]);
  const detailed = await collect({
    collection: "nodes",
    include_observations: true,
  });
  expect(ids(detailed)).toEqual(ids(graph.nodes));
  expect(detailed.map(({ observations }) => observations)).toEqual(
    graph.nodes.map(({ observations }) => observations),
  );
  expect(ids(detailed.filter(({ seed }) => seed === true))).toEqual(
    ids(graph.nodes.filter(({ node_id: id }) => seeds.has(id))),
  );
  const compact = await view({ kind: "feature-trace", collection: "nodes" });
  expect(compact.items[0]).not.toHaveProperty("observations");
  expect(compact.items[0]).toMatchObject({
    node_id: graph.nodes[0]!.node_id,
    observation_count: graph.nodes[0]!.observations.length,
  });

  const seed = full.seed_matches[0]!.node_id;
  expect(
    await collect({ collection: "edges", where: { node_ids: [seed] } }),
  ).toEqual(
    graph.edges.filter(
      (edge) => edge.source_node_id === seed || edge.target_node_id === seed,
    ),
  );
  expect(
    await collect({ collection: "paths", where: { node_ids: [seed] } }),
  ).toEqual(full.paths.filter(({ node_ids: path }) => path.includes(seed)));
  expect(
    ids(
      await collect({ collection: "nodes", where: { kinds: ["ipc-channel"] } }),
    ),
  ).toEqual(ids(graph.nodes.filter(({ kind }) => kind === "ipc-channel")));
  expect(
    await collect({ collection: "edges", where: { relations: ["handles"] } }),
  ).toEqual(graph.edges.filter(({ relation }) => relation === "handles"));
  for (const selection of [
    { collection: "paths", where: { node_ids: [] } },
    { collection: "paths", where: { end_kinds: [] } },
    { collection: "nodes", where: { kinds: [] } },
    { collection: "edges", where: { relations: [] } },
    { collection: "paths", offset: full.paths.length },
  ])
    expect(await view({ kind: "feature-trace", ...selection })).toMatchObject({
      items: [],
      coverage: { status: "empty", exhausted: true },
      trace_coverage: full.coverage,
    });

  // Views owned by other parents, and unknown filter values, are rejected rather than reinterpreted.
  for (const selection of [
    { kind: "page", collection: "modules", offset: 0, limit: 1 },
    {
      kind: "feature-trace",
      collection: "nodes",
      where: { kinds: ["not-a-kind"] },
    },
    { kind: "feature-trace", collection: "graph" },
  ])
    expect(
      parseMcpToolError(
        await reply("inspect_analysis_view", { source, view: selection }),
      ),
    ).toMatchObject({ error: { code: "invalid_request" } });
};

it("keeps a no-match trace's discovery and empty collections explicit", async () => {
  const { inputs, call } = await connect("full");
  const missing = {
    ...inputs,
    seed: { kind: "string", value: "absent-literal", match: "exact" },
  };
  const summary = await call("trace_application_feature", {
    ...missing,
    view: { kind: "summary" },
  });
  expect(summary.evidence.normalized_result).toMatchObject({
    summary: {
      summary: { matched_seeds: 0, traced_nodes: 0 },
      trace_coverage: { status: "no-match" },
      graph_coverage: null,
      semantic_discovery: { total: 0, next_offset: null },
    },
  });
  const nodes = await call("trace_application_feature", {
    ...missing,
    view: { kind: "feature-trace", collection: "nodes" },
  });
  expect(nodes.evidence.normalized_result).toMatchObject({
    items: [],
    graph_coverage: null,
    coverage: { status: "empty", total: 0, exhausted: true },
  });
});

it("refuses a selected view before tracing when the server retains no Evidence", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider");
  });
  const server = createServer({ kind: "fixed", analysis: session });
  const client = new Client({ name: "feature-trace-fixed", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const refused = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      view: { kind: "summary" },
    },
  });
  expect(parseMcpToolError(refused)).toMatchObject({
    error: {
      code: "capability_unavailable",
      message: expect.stringContaining("does not retain Evidence"),
    },
  });
  const complete = await client.callTool({
    name: "trace_application_feature",
    arguments: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  });
  expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
  expect(
    traced(parseEvidence(complete.structuredContent)).summary,
  ).toMatchObject({ matched_seeds: 1 });
});

it("recovers an oversized completed trace through its retained paths page", async () => {
  const budget = 64 * 1024;
  const { session, inputs, call, reply } = await connect("full", budget);
  const failed = await reply("trace_application_feature", inputs);
  const error = parseMcpToolError(failed).error;
  expect(error.code).toBe("resource_constraint");
  expect(error.remediation?.action).toContain("inspect_analysis_view");
  const limits = z
    .object({ details: z.object({ reported_limits: jsonObjectSchema }) })
    .parse(error).details.reported_limits;
  const reference = z
    .object({ kind: z.literal("retained-evidence"), evidence_id: z.string() })
    .parse(limits.evidence_reference);
  const parent = parseEvidence(session.evidenceById(reference.evidence_id));
  const full = traced(parent);
  expect(bytes(parent)).toBeGreaterThan(budget);
  const continuation = z
    .object({
      name: z.literal("inspect_analysis_view"),
      arguments: toolContract("inspect_analysis_view").inputSchema,
    })
    .parse(limits.continuation);
  expect(continuation.arguments).toEqual({
    source: reference,
    view: {
      kind: "feature-trace",
      collection: "paths",
      where: {},
      offset: 0,
      limit: 64,
    },
  });
  const first = await call(continuation.name, continuation.arguments);
  expect(first.evidence.normalized_result).toMatchObject({
    kind: "feature-trace",
    parent_evidence_id: parent.evidence_id,
    trace_id: full.trace_id,
    summary: full.summary,
    items: full.paths,
    coverage: { total: full.paths.length, exhausted: true },
  });
  expect(bytes(first.result)).toBeLessThan(budget);
  // A selected initial view also fits where the complete reply cannot.
  const summary = await call("trace_application_feature", {
    ...inputs,
    view: { kind: "summary" },
  });
  expect(summary.evidence.normalized_result).toMatchObject({
    parent_evidence_id: parent.evidence_id,
  });
});
