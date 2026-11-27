import { join } from "node:path";
import { expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import type { AndroidAnalysisPort } from "../../../src/ports/android/AndroidAnalysisPort.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";

const identity = { id: "jadx", name: "JADX", version: "0.8.0" };
const engine = {
  name: "jadx-headless-mcp",
  version: "0.8.0",
  artifact_sha256: "b".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};

/** `count` using nodes spread over three packages, five per top class. */
const trace = (count: number) => ({
  engine,
  target_definition: "defined",
  class_name: "com.example.Player",
  method_name: null,
  overload_index: null,
  reported_signature: null,
  dex_descriptor: null,
  total: count,
  direct_invokes_coverage: {
    complete_using_nodes: 0,
    partial_using_nodes: 0,
    unknown_using_nodes: count,
    recorded_sites: 0,
  },
  references: Array.from({ length: count }, (_, index) => {
    const pkg = ["com.example.ui", "com.example.media", ""][index % 3]!;
    const owner = `Owner${String(Math.floor(index / 5))}`;
    const top = pkg === "" ? owner : `${pkg}.${owner}`;
    return {
      kind: index % 4 === 0 ? "method" : "class",
      name: `node${String(index)}`,
      reported_full_name: `${top}.node${String(index)}`,
      containing_class: top,
      top_class: top,
      source_line: null,
      dex_offset: null,
      direct_invokes_exhaustive: null,
      direct_invokes: null,
    };
  }),
  coverage: "complete",
  reference_unit: "using_node",
});

const connect = async (count: number) => {
  const root = await createTestTempDirectory("rea-android-references-");
  const path = join(root, "probe.apk");
  await writeOrderedZip(path, ["AndroidManifest.xml", "classes.dex"]);
  const provider: AndroidAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(_target, request) {
      if (request.operation !== "trace_android_references")
        throw new Error(`Unexpected ${request.operation}`);
      return ok(createAnalysisExecution(trace(count), identity));
    },
  };
  const { client } = await createApplicationMcpHarness({
    serverOptions: { androidAnalysis: provider },
    // These cases cover the budget's choice for an omitted detail.
    testDelivery: "budgeted",
  });
  const definitions = (await client.listTools()).tools;
  const reply = async (name: string, args: Record<string, unknown>) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing tool ${name}`);
    return client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return parseEvidence(result.structuredContent);
  };
  return { call, reply, target: { path, class_name: "com.example.Player" } };
};

it("summarizes a large trace and pages its top classes and using nodes", async () => {
  const { call, target } = await connect(300);
  const summary = await call("trace_android_references", target);
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "trace_android_references",
      summary: {
        total: 300,
        counts: {
          references: 300,
          by_kind: { method: 75, class: 225 },
          top_classes: 180,
          packages: 3,
        },
        packages: {
          items: [
            { package: "", references: 100 },
            { package: "com.example.media", references: 100 },
            { package: "com.example.ui", references: 100 },
          ],
          omitted: 0,
        },
      },
    },
  });
  expect(summary.normalized_result).not.toHaveProperty("summary.references");
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };

  const tops = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "android-references",
      facet: "top-classes",
      packages: ["com.example.ui"],
      limit: 2,
    },
  });
  expect(tops.normalized_result).toMatchObject({
    target: { class_name: "com.example.Player", total: 300 },
    items: [
      { top_class: "com.example.ui.Owner0", references: 2 },
      { top_class: "com.example.ui.Owner1", references: 2 },
    ],
    coverage: { total: 60, next_offset: 2 },
  });

  const unnamed = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "android-references",
      facet: "references",
      packages: [""],
      limit: 1,
    },
  });
  expect(unnamed.normalized_result).toMatchObject({
    items: [{ index: 2, top_class: "Owner0" }],
    coverage: { total: 100 },
  });

  const methods = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "android-references",
      facet: "references",
      kinds: ["method"],
      fields: ["name", "top_class"],
      offset: 1,
      limit: 1,
    },
  });
  expect(methods.normalized_result).toMatchObject({
    items: [{ index: 4, name: "node4", top_class: "com.example.media.Owner0" }],
    coverage: { total: 75, next_offset: 2 },
  });
  expect(methods.normalized_result).not.toHaveProperty("items.0.kind");
});

it("returns a view page in the trace call and refuses a view without summary", async () => {
  const { call, reply, target } = await connect(300);
  const page = await call("trace_android_references", {
    ...target,
    detail: "summary",
    view: {
      kind: "android-references",
      facet: "top-classes",
      packages: [""],
      top_classes: ["Owner2", "com.example.ui.Owner2"],
    },
  });
  expect(page.normalized_result).toMatchObject({
    facet: "top-classes",
    items: [{ top_class: "Owner2", package: "" }],
  });
  const refused = await reply("trace_android_references", {
    ...target,
    view: { kind: "android-references", facet: "references" },
  });
  expect(refused.isError).toBe(true);
});

it("returns a small trace inline when detail is omitted", async () => {
  const { call, target } = await connect(3);
  expect(await call("trace_android_references", target)).toMatchObject({
    operation: "trace_android_references",
    normalized_result: { total: 3 },
  });
});
