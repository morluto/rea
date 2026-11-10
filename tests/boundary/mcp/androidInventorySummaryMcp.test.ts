import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, vi } from "vitest";
import type { AndroidAnalysisPort } from "../../../src/application/android/AndroidAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import {
  androidClassesPageViewResultSchema,
  androidClassesSummaryViewResultSchema,
  androidReferencesPageViewResultSchema,
  androidReferencesSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";

const CLASSES = 1200;
const REFERENCES = 900;
const engine = {
  name: "contract fixture",
  version: "1",
  artifact_sha256: "b".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};
const classNames = Array.from(
  { length: CLASSES },
  (_, index) => `fixture.pkg${index % 3}.sub.C${index}`,
);
const referenceRows = Array.from({ length: REFERENCES }, (_, index) => ({
  kind: index % 4 === 0 ? "method" : "class",
  name: `m${index}`,
  reported_full_name: `fixture.Caller${index % 5}.m${index}`,
  containing_class: `fixture.Caller${index % 5}`,
  top_class: `fixture.Caller${index % 5}`,
  source_line: null,
  dex_offset: null,
  direct_invokes_exhaustive: index % 2 === 0 ? true : null,
  direct_invokes:
    index % 2 === 0
      ? [
          {
            dex_entry: "classes.dex",
            source_raw_method_id: `Lfixture/Caller;->m${index}()V`,
            dex_code_unit_offset: index,
            dex_method_index: index,
            opcode: "INVOKE_STATIC",
          },
        ]
      : null,
}));

const createFixture = async () => {
  const root = await createTestTempDirectory("rea-android-inventory-mcp-");
  const apk = join(root, "selected.apk");
  await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
  const execute = vi.fn<AndroidAnalysisPort["execute"]>(
    async (target, request) => {
      const result =
        request.operation === "search_android_classes"
          ? androidResultSchemas.search_android_classes.parse({
              engine,
              query: request.input.query,
              total_classes: CLASSES,
              matches: classNames,
              duplicate_names: [
                { name: "fixture.pkg0.sub.C0", occurrences: 2 },
              ],
              coverage: "complete",
            })
          : androidResultSchemas.trace_android_references.parse({
              engine,
              class_name: "fixture.Util",
              method_name: null,
              overload_index: null,
              reported_signature: null,
              dex_descriptor: null,
              total: REFERENCES,
              references: referenceRows,
              coverage: "complete",
              reference_unit: "using_node",
            });
      return ok(
        createAnalysisExecution(
          result,
          { id: "inventory-fixture", name: "Inventory fixture", version: "1" },
          { rawResult: { retained: "x".repeat(4096) }, subject: target },
        ),
      );
    },
  );
  const harness = await createApplicationMcpHarness({
    serverOptions: {
      androidAnalysis: {
        execute,
        close: async () => {},
        inspectAvailability: vi.fn(),
      },
      environment: { REA_MCP_TOOL_FAMILIES: "android,application,session" },
    },
  });
  return { ...harness, apk, execute };
};

const outputSchemaOf = async (
  client: Awaited<ReturnType<typeof createFixture>>["client"],
  name: string,
) => {
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === name,
  );
  if (definition?.outputSchema === undefined)
    throw new Error(`Missing ${name} schema`);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
  expect(ajv.validateSchema(definition.outputSchema)).toBe(true);
  return { ajv, schema: definition.outputSchema as Record<string, unknown> };
};

it("summarizes a large class inventory, retains every row and pages it without the APK", async () => {
  const { client, session, apk, execute } = await createFixture();
  const { ajv, schema } = await outputSchemaOf(
    client,
    "search_android_classes",
  );
  const reply = await client.callTool({
    name: "search_android_classes",
    arguments: { path: apk, query: "", detail: "summary" },
  });
  expect(reply.isError).not.toBe(true);
  expect(
    ajv.validate(schema, reply.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  // Delivery options never reach the provider's analysis request.
  expect(execute.mock.calls[0]?.[1]).toEqual({
    operation: "search_android_classes",
    input: { path: apk, query: "" },
  });
  const receipt = parseEvidence(reply.structuredContent);
  const summary = androidClassesSummaryViewResultSchema.parse(
    receipt.normalized_result,
  );
  expect(summary.summary.counts).toEqual({
    matches: CLASSES,
    duplicate_names: 1,
  });
  expect(summary.summary.matches).toHaveLength(64);
  expect(summary.summary.packages).toMatchObject({
    depth: 2,
    total_prefixes: 3,
    top: [
      { prefix: "fixture.pkg0", classes: 400 },
      { prefix: "fixture.pkg1", classes: 400 },
      { prefix: "fixture.pkg2", classes: 400 },
    ],
  });
  expect(receipt.raw_result).toBeNull();
  const parent = session.evidenceById(summary.parent_evidence_id);
  if (parent === undefined) throw new Error("Complete parent was not retained");
  expect(
    androidResultSchemas.search_android_classes.parse(parent.normalized_result)
      .matches,
  ).toHaveLength(CLASSES);
  await unlink(apk);
  const rows: { name: string; row_index: number }[] = [];
  for (let offset = 0; offset < CLASSES; offset += 500) {
    const page = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: {
          kind: "android-classes",
          collection: "matches",
          offset,
          limit: 500,
        },
      },
    });
    expect(page.isError).not.toBe(true);
    const projected = androidClassesPageViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    rows.push(...(projected.items as { name: string; row_index: number }[]));
    expect(projected.coverage.exhausted).toBe(offset + 500 >= CLASSES);
  }
  // Every row is returned once, in source order, with its original position.
  expect(rows.map((row) => row.row_index)).toEqual(
    Array.from({ length: CLASSES }, (_, index) => index),
  );
  expect(rows.map((row) => row.name)).toEqual(classNames);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("filters class pages, serves repeated names and keeps complete delivery unchanged", async () => {
  const { client, apk, execute } = await createFixture();
  const direct = await client.callTool({
    name: "search_android_classes",
    arguments: {
      path: apk,
      query: "",
      detail: "summary",
      view: {
        kind: "android-classes",
        collection: "matches",
        package_prefix: "fixture.pkg1.",
        offset: 10,
        limit: 3,
      },
    },
  });
  expect(direct.isError).not.toBe(true);
  const page = androidClassesPageViewResultSchema.parse(
    parseEvidence(direct.structuredContent).normalized_result,
  );
  expect(page.coverage).toMatchObject({ total: 400, next_offset: 13 });
  expect(
    (page.items as { name: string; row_index: number }[]).map(
      (row) => row.row_index,
    ),
  ).toEqual([31, 34, 37]);
  const duplicates = await client.callTool({
    name: "search_android_classes",
    arguments: {
      path: apk,
      query: "",
      detail: "summary",
      view: { kind: "android-classes", collection: "duplicate_names" },
    },
  });
  expect(duplicates.isError).not.toBe(true);
  expect(
    androidClassesPageViewResultSchema.parse(
      parseEvidence(duplicates.structuredContent).normalized_result,
    ).items,
  ).toEqual([{ name: "fixture.pkg0.sub.C0", occurrences: 2, row_index: 0 }]);
  const complete = await client.callTool({
    name: "search_android_classes",
    arguments: { path: apk, query: "" },
  });
  expect(complete.isError).not.toBe(true);
  expect(
    androidResultSchemas.search_android_classes.parse(
      parseEvidence(complete.structuredContent).normalized_result,
    ).matches,
  ).toHaveLength(CLASSES);
  for (const refused of [
    {
      path: apk,
      query: "",
      view: { kind: "android-classes", collection: "matches" },
    },
    {
      path: apk,
      query: "",
      detail: "summary",
      view: { kind: "android-references", collection: "references" },
    },
  ]) {
    const reply = await client.callTool({
      name: "search_android_classes",
      arguments: refused,
    });
    expect(reply.isError, JSON.stringify(refused)).toBe(true);
  }
  expect(execute).toHaveBeenCalledTimes(3);
});

it("summarizes a reference trace without raw invokes and pages them on request", async () => {
  const { client, session, apk, execute } = await createFixture();
  const { ajv, schema } = await outputSchemaOf(
    client,
    "trace_android_references",
  );
  const reply = await client.callTool({
    name: "trace_android_references",
    arguments: { path: apk, class_name: "fixture.Util", detail: "summary" },
  });
  expect(reply.isError).not.toBe(true);
  expect(
    ajv.validate(schema, reply.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  expect(execute.mock.calls[0]?.[1]).toEqual({
    operation: "trace_android_references",
    input: { path: apk, class_name: "fixture.Util" },
  });
  const summary = androidReferencesSummaryViewResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(summary.summary.counts).toEqual({ references: REFERENCES });
  expect(summary.summary.total).toBe(REFERENCES);
  expect(summary.summary.kinds).toEqual([
    { kind: "class", references: 675 },
    { kind: "method", references: 225 },
  ]);
  expect(summary.summary.top_classes.total_top_classes).toBe(5);
  expect(summary.summary.references).toHaveLength(64);
  // Raw invoke offsets stay in the retained Evidence; the preview does not carry them.
  expect(
    summary.summary.references.some((row) => "direct_invokes" in row),
  ).toBe(false);
  expect(summary.unknowns.join(" ")).toContain("direct_invokes");
  const parent = session.evidenceById(summary.parent_evidence_id);
  if (parent === undefined) throw new Error("Complete parent was not retained");
  await unlink(apk);
  const seen: number[] = [];
  let withInvokes = 0;
  for (let offset = 0; offset < REFERENCES; offset += 400) {
    const page = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: {
          kind: "android-references",
          collection: "references",
          offset,
          limit: 400,
          fields: ["name", "direct_invokes"],
        },
      },
    });
    expect(page.isError).not.toBe(true);
    const projected = androidReferencesPageViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    for (const item of projected.items) {
      seen.push(item.row_index);
      if (Array.isArray(item.direct_invokes)) withInvokes++;
    }
  }
  expect(seen).toEqual(Array.from({ length: REFERENCES }, (_, index) => index));
  expect(withInvokes).toBe(REFERENCES / 2);
  const filtered = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: {
        kind: "android-references",
        collection: "references",
        top_classes: ["fixture.Caller2"],
        kinds: ["method"],
        fields: ["name", "top_class"],
        limit: 2,
      },
    },
  });
  expect(filtered.isError).not.toBe(true);
  const projected = androidReferencesPageViewResultSchema.parse(
    parseEvidence(filtered.structuredContent).normalized_result,
  );
  // Methods are rows divisible by 4 and Caller2 rows are 2 modulo 5, so 12 modulo 20.
  expect(projected.items.map((item) => item.row_index)).toEqual([12, 32]);
  expect(projected.coverage).toMatchObject({ total: 45 });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("keeps complete trace delivery unchanged and refuses a misplaced view", async () => {
  const { client, apk, execute } = await createFixture();
  const complete = await client.callTool({
    name: "trace_android_references",
    arguments: { path: apk, class_name: "fixture.Util" },
  });
  expect(complete.isError).not.toBe(true);
  expect(
    androidResultSchemas.trace_android_references.parse(
      parseEvidence(complete.structuredContent).normalized_result,
    ).references,
  ).toHaveLength(REFERENCES);
  for (const refused of [
    {
      path: apk,
      class_name: "fixture.Util",
      view: { kind: "android-references", collection: "references" },
    },
    {
      path: apk,
      class_name: "fixture.Util",
      detail: "summary",
      view: { kind: "android-classes", collection: "matches" },
    },
  ]) {
    const reply = await client.callTool({
      name: "trace_android_references",
      arguments: refused,
    });
    expect(reply.isError, JSON.stringify(refused)).toBe(true);
  }
  expect(execute).toHaveBeenCalledTimes(1);
});
