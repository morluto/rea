import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { immutableJsonSnapshotMember } from "../immutableJson.js";
import {
  androidClassesViewRequestSchema,
  androidReferencesViewRequestSchema,
} from "../android/androidInventoryQuery.js";
import {
  androidClassesPageViewResultSchema,
  androidClassesSummaryViewResultSchema,
  androidReferencesPageViewResultSchema,
  androidReferencesSummaryViewResultSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const engine = {
  name: "jadx-headless-mcp",
  version: "0.7.1",
  artifact_sha256: "e".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};
const names = Array.from(
  { length: 1200 },
  (_, index) => `fixture.pkg${index % 2}.sub.C${index}`,
);
const classesReport = (overrides: Record<string, unknown> = {}) => ({
  engine,
  query: "",
  total_classes: names.length,
  matches: names,
  duplicate_names: [
    { name: "fixture.pkg0.sub.C0", occurrences: 2 },
    { name: "fixture.pkg1.sub.C1", occurrences: 3 },
  ],
  coverage: "complete",
  ...overrides,
});
const references = Array.from({ length: 700 }, (_, index) => ({
  kind: index % 7 === 0 ? "method" : "class",
  name: `m${index}`,
  reported_full_name: `fixture.Caller${index % 3}.m${index}`,
  containing_class: `fixture.Caller${index % 3}`,
  top_class: `fixture.Caller${index % 3}`,
  source_line: null,
  dex_offset: null,
  direct_invokes_exhaustive: true,
  direct_invokes: [
    {
      dex_entry: "classes.dex",
      source_raw_method_id: `Lfixture/Caller;->m${index}()V`,
      dex_code_unit_offset: index,
      dex_method_index: index,
      opcode: "INVOKE_STATIC",
    },
  ],
}));
const referencesReport = (overrides: Record<string, unknown> = {}) => ({
  engine,
  class_name: "fixture.Util",
  method_name: null,
  overload_index: null,
  reported_signature: null,
  dex_descriptor: null,
  total: references.length,
  references,
  coverage: "complete",
  reference_unit: "using_node",
  ...overrides,
});
const fixture = (
  operation: "search_android_classes" | "trace_android_references",
  result: unknown,
) => {
  const evidence = createEvidence(
    { path: "/retained/selected.apk", sha256: "a".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.7.1" },
    {
      operation,
      parameters: { path: "/caller/selected.apk" },
      result,
      rawResult: { calls: [] },
      limitations: ["Names are decompiler display names."],
    },
    { immutable: true },
  );
  const parent: AnalysisViewParent = {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation,
    normalizedResult:
      immutableJsonSnapshotMember(evidence, "normalized_result") ??
      evidence.normalized_result,
    subject: evidence.subject,
    sealedResult: true,
    limitations: evidence.limitations,
  };
  return { parent, evidence };
};
const classesPage = (
  parent: AnalysisViewParent,
  view: Record<string, unknown>,
) => {
  const result = projectAnalysisView(
    parent,
    androidClassesViewRequestSchema.parse({
      kind: "android-classes",
      collection: "matches",
      ...view,
    }),
  );
  if (!result.ok) throw result.error;
  return androidClassesPageViewResultSchema.parse(result.value);
};
const referencesPage = (
  parent: AnalysisViewParent,
  view: Record<string, unknown>,
) => {
  const result = projectAnalysisView(
    parent,
    androidReferencesViewRequestSchema.parse({
      kind: "android-references",
      collection: "references",
      ...view,
    }),
  );
  if (!result.ok) throw result.error;
  return androidReferencesPageViewResultSchema.parse(result.value);
};

it("summarizes class names with counts, a derived package histogram and a bounded preview", () => {
  const { parent, evidence } = fixture(
    "search_android_classes",
    classesReport(),
  );
  const before = JSON.stringify(evidence);
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  const view = androidClassesSummaryViewResultSchema.parse(result.value);
  expect(view.summary.counts).toEqual({ matches: 1200, duplicate_names: 2 });
  expect(view.summary.matches).toEqual(names.slice(0, 64));
  expect(view.summary.packages).toEqual({
    depth: 2,
    total_prefixes: 2,
    top: [
      { prefix: "fixture.pkg0", classes: 600 },
      { prefix: "fixture.pkg1", classes: 600 },
    ],
  });
  expect(view.summary.match_coverage).toMatchObject({
    examined: 64,
    total: 1200,
    next_offset: 64,
  });
  expect(view.summary.duplicate_coverage.exhausted).toBe(true);
  expect(view.artifact).toEqual({
    path: "/retained/selected.apk",
    sha256: "a".repeat(64),
  });
  // The decompiler's display inventory is not claimed to be every DEX class.
  expect(view.unknowns.join(" ")).toContain("top-level");
  expect(JSON.stringify(evidence)).toBe(before);
});

it("orders equal package counts by name and counts prefixes it does not list", () => {
  const many = Array.from(
    { length: 45 },
    (_, index) => `zz.p${String(index).padStart(2, "0")}.A`,
  );
  const { parent } = fixture(
    "search_android_classes",
    classesReport({ matches: many, total_classes: many.length }),
  );
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  const view = androidClassesSummaryViewResultSchema.parse(result.value);
  expect(view.summary.packages.total_prefixes).toBe(45);
  expect(view.summary.packages.top).toHaveLength(20);
  expect(view.summary.packages.top.map((row) => row.prefix)).toEqual(
    many.slice(0, 20).map((name) => name.slice(0, -2)),
  );
  // Package-less and single-segment names stay countable under their own text.
  const flat = fixture(
    "search_android_classes",
    classesReport({ matches: ["Top", "a.B"], total_classes: 2 }),
  );
  const flatResult = projectAnalysisView(flat.parent, { kind: "summary" });
  if (!flatResult.ok) throw flatResult.error;
  expect(
    androidClassesSummaryViewResultSchema.parse(flatResult.value).summary
      .packages.top,
  ).toEqual([
    { prefix: "Top", classes: 1 },
    { prefix: "a.B", classes: 1 },
  ]);
});

it("pages class names with stable original indices until exhausted", () => {
  const { parent } = fixture("search_android_classes", classesReport());
  const seen: { name: string; row_index: number }[] = [];
  let offset = 0;
  for (;;) {
    const result = classesPage(parent, { offset, limit: 500 });
    seen.push(...(result.items as { name: string; row_index: number }[]));
    if (result.coverage.exhausted) break;
    expect(result.coverage.next_offset).toBe(offset + 500);
    offset = result.coverage.next_offset ?? offset;
  }
  expect(seen.map((row) => row.row_index)).toEqual(
    Array.from({ length: 1200 }, (_, index) => index),
  );
  expect(seen.map((row) => row.name)).toEqual(names);
  expect(classesPage(parent, { offset: 5000 }).coverage).toMatchObject({
    status: "empty",
    exhausted: true,
  });
});

it("filters class names by exact name, literal prefix and index, and serves repeated names", () => {
  const { parent } = fixture("search_android_classes", classesReport());
  expect(
    classesPage(parent, { class_names: ["fixture.pkg1.sub.C7"] }).items,
  ).toEqual([{ name: "fixture.pkg1.sub.C7", row_index: 7 }]);
  const prefix = classesPage(parent, {
    package_prefix: "fixture.pkg1.",
    limit: 3,
  });
  expect(prefix.coverage.total).toBe(600);
  expect(
    (prefix.items as { row_index: number }[]).map((row) => row.row_index),
  ).toEqual([1, 3, 5]);
  expect(classesPage(parent, { class_names: [] }).items).toEqual([]);
  expect(
    (
      classesPage(parent, { indices: [3, 2] }).items as {
        row_index: number;
      }[]
    ).map((row) => row.row_index),
  ).toEqual([2, 3]);
  expect(classesPage(parent, { collection: "duplicate_names" }).items).toEqual([
    { name: "fixture.pkg0.sub.C0", occurrences: 2, row_index: 0 },
    { name: "fixture.pkg1.sub.C1", occurrences: 3, row_index: 1 },
  ]);
  expect(
    classesPage(parent, {
      collection: "duplicate_names",
      class_names: ["fixture.pkg1.sub.C1"],
    }).items,
  ).toEqual([{ name: "fixture.pkg1.sub.C1", occurrences: 3, row_index: 1 }]);
});

it("summarizes a trace with histograms and a preview that omits raw invokes", () => {
  const { parent, evidence } = fixture(
    "trace_android_references",
    referencesReport(),
  );
  const before = JSON.stringify(evidence);
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  const view = androidReferencesSummaryViewResultSchema.parse(result.value);
  expect(view.summary.counts).toEqual({ references: 700 });
  expect(view.summary.total).toBe(700);
  expect(view.summary.kinds).toEqual([
    { kind: "class", references: 600 },
    { kind: "method", references: 100 },
  ]);
  expect(view.summary.top_classes.total_top_classes).toBe(3);
  expect(view.summary.top_classes.top[0]).toEqual({
    top_class: "fixture.Caller0",
    references: 234,
  });
  expect(view.summary.references).toHaveLength(64);
  expect(view.summary.references.map((row) => row.row_index)).toEqual(
    Array.from({ length: 64 }, (_, index) => index),
  );
  expect(view.summary.references.some((row) => "direct_invokes" in row)).toBe(
    false,
  );
  expect(view.summary.references[0]).toMatchObject({
    name: "m0",
    direct_invokes_exhaustive: true,
  });
  expect(view.summary).toMatchObject({
    class_name: "fixture.Util",
    coverage: "complete",
    reference_unit: "using_node",
  });
  expect(view.unknowns.join(" ")).toContain("direct_invokes");
  expect(JSON.stringify(evidence)).toBe(before);
});

it("pages references, selects fields and filters by kind and class", () => {
  const { parent } = fixture("trace_android_references", referencesReport());
  const seen: number[] = [];
  let offset = 0;
  for (;;) {
    const result = referencesPage(parent, {
      offset,
      limit: 300,
      fields: ["name", "direct_invokes"],
    });
    for (const item of result.items) {
      seen.push(item.row_index);
      expect(item.direct_invokes).toHaveLength(1);
      expect(item).not.toHaveProperty("kind");
    }
    if (result.coverage.exhausted) break;
    offset = result.coverage.next_offset ?? offset;
  }
  expect(seen).toEqual(Array.from({ length: 700 }, (_, index) => index));
  const methods = referencesPage(parent, {
    kinds: ["method"],
    top_classes: ["fixture.Caller1"],
    fields: ["name"],
    limit: 2,
  });
  // Methods are rows divisible by 7, and Caller1 rows are 1 modulo 3: 7 modulo 21.
  expect(methods.items.map((item) => item.row_index)).toEqual([7, 28]);
  expect(methods.coverage.total).toBe(33);
  expect(
    referencesPage(parent, { containing_classes: ["fixture.Caller2"] }).coverage
      .total,
  ).toBe(233);
  expect(referencesPage(parent, { kinds: [] }).items).toEqual([]);
  expect(referencesPage(parent, { top_classes: [] }).items).toEqual([]);
  expect(
    referencesPage(parent, { indices: [5, 1] }).items.map(
      (item) => item.row_index,
    ),
  ).toEqual([1, 5]);
});

it("keeps unknown direct-invoke evidence unknown in pages and the summary", () => {
  const rows = references.slice(0, 3).map((row, index) => ({
    ...row,
    direct_invokes_exhaustive: index === 0 ? null : false,
    direct_invokes: index === 0 ? null : row.direct_invokes,
  }));
  const { parent } = fixture(
    "trace_android_references",
    referencesReport({ references: rows, total: 3 }),
  );
  const page = referencesPage(parent, {
    fields: ["direct_invokes", "direct_invokes_exhaustive"],
  });
  expect(page.items[0]).toEqual({
    direct_invokes: null,
    direct_invokes_exhaustive: null,
    row_index: 0,
  });
  expect(page.items[1]?.direct_invokes_exhaustive).toBe(false);
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  const summary = androidReferencesSummaryViewResultSchema.parse(result.value);
  expect(summary.summary.references[0]).toMatchObject({
    direct_invokes_exhaustive: null,
  });
  expect(summary.summary.references[0]).not.toHaveProperty("direct_invokes");
});

it("refuses other parent operations, foreign views and Evidence without an APK subject", () => {
  const classes = fixture("search_android_classes", classesReport());
  const trace = fixture("trace_android_references", referencesReport());
  expect(
    projectAnalysisView(
      { ...classes.parent, operation: "inspect_android_package" },
      { kind: "summary" },
    ).ok,
  ).toBe(false);
  expect(
    projectAnalysisView(
      { ...classes.parent, subject: null },
      { kind: "summary" },
    ).ok,
  ).toBe(false);
  expect(
    projectAnalysisView({ ...trace.parent, subject: null }, { kind: "summary" })
      .ok,
  ).toBe(false);
  expect(
    projectAnalysisView(
      trace.parent,
      androidClassesViewRequestSchema.parse({
        kind: "android-classes",
        collection: "matches",
      }),
    ).ok,
  ).toBe(false);
  expect(
    projectAnalysisView(
      classes.parent,
      androidReferencesViewRequestSchema.parse({
        kind: "android-references",
        collection: "references",
      }),
    ).ok,
  ).toBe(false);
});

it("fails with a recoverable budget error instead of returning an oversized page", () => {
  const huge = Array.from({ length: 400 }, (_, index) => ({
    ...references[0]!,
    name: `m${index}`,
    direct_invokes: Array.from({ length: 40 }, (_, site) => ({
      dex_entry: "classes.dex",
      source_raw_method_id: `Lfixture/Caller;->m${index}_${site}()V`.padEnd(
        200,
        "x",
      ),
      dex_code_unit_offset: site,
      dex_method_index: site,
      opcode: "INVOKE_STATIC",
    })),
  }));
  const { parent } = fixture(
    "trace_android_references",
    referencesReport({ references: huge, total: huge.length }),
  );
  const result = projectAnalysisView(
    parent,
    androidReferencesViewRequestSchema.parse({
      kind: "android-references",
      collection: "references",
      limit: 400,
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error._tag).toBe("AnalysisResourceConstraintError");
});
