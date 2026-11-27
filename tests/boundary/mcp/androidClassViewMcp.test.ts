import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import type { AndroidAnalysisPort } from "../../../src/ports/android/AndroidAnalysisPort.js";
import { androidClassPageViewResultSchema } from "../../../src/domain/analysisView/summarySchemas/androidSummarySchemas.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { listedEvidenceCaller } from "../../support/mcp/listedEvidenceCaller.js";
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

/** A class with `count` methods: two constructors, a seek overload set, and one-offs. */
const inspected = (count: number) => {
  const methods = Array.from({ length: count }, (_, index) => {
    const name =
      index < 2 ? "<init>" : index < 6 ? "seek" : `method${String(index)}`;
    const descriptor = index < 2 ? "()V" : index < 6 ? "(I)V" : "()V";
    return {
      name,
      reported_signature: `${name}(): void`,
      overload_index: index < 2 ? index : index < 6 ? index - 2 : 0,
      is_constructor: index < 2,
      dex_descriptor: descriptor,
    };
  });
  return {
    engine,
    class_name: "com.example.Player",
    methods,
    fields: Array.from({ length: 40 }, (_, index) => ({
      name: index % 2 === 0 ? `KEY_${String(index)}` : `field${String(index)}`,
      reported_type: "java.lang.String",
      dex_static_value:
        index % 2 === 0
          ? { type: "string", value: `key_${String(index)}` }
          : null,
    })),
    inner_classes: ["com.example.Player.Companion"],
  };
};

const connect = async (count: number) => {
  const root = await createTestTempDirectory("rea-android-class-");
  const path = join(root, "probe.apk");
  await writeOrderedZip(path, ["AndroidManifest.xml", "classes.dex"]);
  const provider: AndroidAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(_target, request) {
      if (request.operation !== "inspect_android_class")
        throw new Error(`Unexpected ${request.operation}`);
      return ok(createAnalysisExecution(inspected(count), identity));
    },
  };
  const { client } = await createApplicationMcpHarness({
    serverOptions: { androidAnalysis: provider },
    // These cases cover the budget's choice for an omitted detail.
    testDelivery: "budgeted",
  });
  const call = listedEvidenceCaller(client, (await client.listTools()).tools);
  return { call, target: { path, class_name: "com.example.Player" } };
};

it("summarizes a large class with counts and pages its members", async () => {
  const { call, target } = await connect(300);
  const summary = await call("inspect_android_class", target);
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "inspect_android_class",
      summary: {
        class_name: "com.example.Player",
        counts: {
          methods: 300,
          constructors: 2,
          overloaded_method_names: 2,
          fields: 40,
          static_values: 20,
          inner_classes: 1,
        },
        overloaded_methods: {
          items: [
            { name: "seek", overloads: 4 },
            { name: "<init>", overloads: 2 },
          ],
          omitted: 0,
        },
      },
    },
  });
  expect(summary.normalized_result).not.toHaveProperty("summary.methods");
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };

  const seek = await call("inspect_analysis_view", {
    source,
    view: { kind: "android-class", facet: "methods", names: ["seek"] },
  });
  expect(seek.normalized_result).toMatchObject({
    class_name: "com.example.Player",
    items: [
      { index: 2, name: "seek", overload_index: 0, dex_descriptor: "(I)V" },
      { index: 3 },
      { index: 4 },
      { index: 5 },
    ],
    coverage: { total: 4, exhausted: true },
  });

  const statics = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "android-class",
      facet: "fields",
      name_prefixes: ["KEY_"],
      static_values: true,
      limit: 1,
    },
  });
  expect(statics.normalized_result).toMatchObject({
    items: [
      {
        index: 0,
        name: "KEY_0",
        dex_static_value: { type: "string", value: "key_0" },
      },
    ],
    coverage: { total: 20, next_offset: 1 },
  });

  const methodPage = androidClassPageViewResultSchema.parse(
    seek.normalized_result,
  );
  const fieldPage = androidClassPageViewResultSchema.parse(
    statics.normalized_result,
  );
  const samples = [
    { facet: "methods", items: methodPage.items },
    { facet: "fields", items: fieldPage.items },
    { facet: "inner-classes", items: ["com.example.Player.Companion"] },
    {
      facet: "mapping-symbols",
      items: [
        {
          kind: "class",
          name: "Player",
          raw_name: "a",
          resolution: { status: "unmapped" },
        },
      ],
    },
  ];
  const validation = createMcpSchemaValidation();
  onTestFinished(() => validation.clear());
  const validators = ["inspect_android_class", "inspect_analysis_view"].map(
    (name) => validation.getValidator(canonicalOutputSchema(name)),
  );
  for (const { facet } of samples) {
    const view = { kind: "android-class", facet, offset: 0, limit: 64 };
    const check = (items: unknown, expected: boolean) => {
      const normalized_result = { ...methodPage, view, items };
      expect(
        androidClassPageViewResultSchema.safeParse(normalized_result).success,
      ).toBe(expected);
      for (const validate of validators)
        expect(validate({ ...seek, normalized_result }).valid).toBe(expected);
    };
    check([], true);
    for (const sample of samples) check(sample.items, sample.facet === facet);
  }
});

it("returns a members page in the class call", async () => {
  const { call, target } = await connect(300);
  const page = await call("inspect_android_class", {
    ...target,
    detail: "summary",
    view: { kind: "android-class", facet: "methods", constructors: true },
  });
  expect(page.normalized_result).toMatchObject({
    kind: "android-class",
    items: [{ name: "<init>" }, { name: "<init>" }],
    coverage: { total: 2 },
  });
});

it("returns a small class inline when detail is omitted", async () => {
  const { call, target } = await connect(8);
  expect(await call("inspect_android_class", target)).toMatchObject({
    operation: "inspect_android_class",
    normalized_result: { methods: expect.any(Array) },
  });
});
