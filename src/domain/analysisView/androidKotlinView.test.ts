import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { immutableJsonSnapshotMember } from "../immutableJson.js";
import { androidKotlinViewRequestSchema } from "../android/androidKotlinQuery.js";
import {
  androidKotlinPageViewResultSchema,
  androidKotlinSummaryViewResultSchema,
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
const kinds = ["class", "file_facade", "synthetic_class"] as const;
const rows = Array.from({ length: 1200 }, (_, index) => ({
  class_name: `fixture.pkg${index % 2}.C${index}`,
  dex_entry: "classes.dex",
  metadata_kind: 1,
  kind: kinds[index % 3],
  metadata_version: "2.1.0",
  extra_int: 48,
  data_strings: 1,
  has_d2: true,
  decode: "not_requested" as const,
}));
const report = (overrides: Record<string, unknown> = {}) => ({
  engine,
  scope: "apk-root-dex-kotlin-metadata",
  coverage: {
    status: "complete",
    dex_entries: 1,
    examined_dex_entries: 1,
    examined_classes: 5000,
    classes_with_metadata: 1200,
    undecodable_classes: 0,
  },
  versions: [{ version: "2.1.0", classes: 1200 }],
  kinds: [
    { kind: "class", classes: 400 },
    { kind: "file_facade", classes: 400 },
    { kind: "synthetic_class", classes: 400 },
  ],
  matching_classes: 1200,
  classes: rows,
  markers: {
    basis: "candidate-static-markers",
    kotlin_module_entries: {
      count: 2,
      names: [
        "META-INF/app_release.kotlin_module",
        "META-INF/domain.kotlin_module",
      ],
      truncated: false,
    },
    class_prefixes: [
      { marker: "compose", prefix: "androidx.compose.", classes: 7 },
      {
        marker: "kotlinx_coroutines",
        prefix: "kotlinx.coroutines.",
        classes: 3,
      },
      { marker: "kotlin_coroutines", prefix: "kotlin.coroutines.", classes: 0 },
    ],
  },
  unknowns: [],
  ...overrides,
});
const fixture = (result: unknown = report()) => {
  const evidence = createEvidence(
    { path: "/retained/selected.apk", sha256: "a".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.7.1" },
    {
      operation: "inspect_android_kotlin_metadata",
      parameters: { path: "/caller/selected.apk" },
      result,
      rawResult: { calls: [] },
      limitations: ["Metadata is what the compiler recorded."],
    },
    { immutable: true },
  );
  const parent: AnalysisViewParent = {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: "inspect_android_kotlin_metadata",
    normalizedResult:
      immutableJsonSnapshotMember(evidence, "normalized_result") ??
      evidence.normalized_result,
    subject: evidence.subject,
    sealedResult: true,
    limitations: evidence.limitations,
  };
  return { parent, evidence };
};
const page = (parent: AnalysisViewParent, view: Record<string, unknown>) => {
  const result = projectAnalysisView(
    parent,
    androidKotlinViewRequestSchema.parse({
      kind: "android-kotlin",
      collection: "classes",
      ...view,
    }),
  );
  if (!result.ok) throw result.error;
  return androidKotlinPageViewResultSchema.parse(result.value);
};

it("summarizes every class with whole-APK histograms and a bounded preview", () => {
  const { parent, evidence } = fixture();
  const before = JSON.stringify(evidence);
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  const view = androidKotlinSummaryViewResultSchema.parse(result.value);
  expect(view.summary.matching_classes).toBe(1200);
  expect(view.summary.retained_classes).toBe(1200);
  expect(view.summary.classes).toHaveLength(64);
  expect(view.summary.markers).toEqual(report().markers);
  expect(view.summary.kinds.map((row) => row.classes)).toEqual([400, 400, 400]);
  expect(view.coverage).toMatchObject({ examined: 64, total: 1200 });
  expect(view.artifact).toEqual({
    path: "/retained/selected.apk",
    sha256: "a".repeat(64),
  });
  expect(JSON.stringify(evidence)).toBe(before);
});

it("pages past 500 rows with stable original indices until exhausted", () => {
  const { parent } = fixture();
  const seen: number[] = [];
  let offset = 0;
  for (;;) {
    const result = page(parent, { offset, limit: 500, fields: ["class_name"] });
    seen.push(...result.items.map((item) => item.row_index));
    if (result.coverage.exhausted) break;
    expect(result.coverage.next_offset).toBe(offset + 500);
    offset = result.coverage.next_offset ?? offset;
  }
  expect(seen).toEqual(Array.from({ length: 1200 }, (_, index) => index));
  const first = page(parent, { offset: 0, limit: 2, fields: ["class_name"] });
  expect(first.items[0]).toEqual({
    class_name: "fixture.pkg0.C0",
    row_index: 0,
  });
});

it("filters by exact name, literal prefix and kind, keeping original indices", () => {
  const { parent } = fixture();
  const exact = page(parent, { class_names: ["fixture.pkg1.C7"] });
  expect(exact.items.map((item) => item.row_index)).toEqual([7]);
  const prefix = page(parent, { package_prefix: "fixture.pkg1.", limit: 3 });
  expect(prefix.coverage.total).toBe(600);
  expect(prefix.items.map((item) => item.row_index)).toEqual([1, 3, 5]);
  const facade = page(parent, { kinds: ["file_facade"], limit: 2 });
  expect(facade.coverage.total).toBe(400);
  expect(facade.items.map((item) => item.row_index)).toEqual([1, 4]);
  expect(page(parent, { kinds: [] }).items).toEqual([]);
  expect(page(parent, { class_names: [] }).items).toEqual([]);
  expect(
    page(parent, { indices: [3, 2] }).items.map((i) => i.row_index),
  ).toEqual([2, 3]);
});

it("keeps a retained-allowance gap visible instead of reporting a complete inventory", () => {
  const { parent } = fixture(
    report({
      coverage: {
        status: "partial",
        dex_entries: 1,
        examined_dex_entries: 1,
        examined_classes: 5000,
        classes_with_metadata: 1200,
        undecodable_classes: 0,
      },
      classes: rows.slice(0, 1000),
      unknowns: ["Rows exceed the retained allowance."],
    }),
  );
  const view = page(parent, { offset: 900, limit: 500 });
  expect(view.source).toMatchObject({
    matching_classes: 1200,
    retained_classes: 1000,
  });
  expect(view.items).toHaveLength(100);
  expect(view.unknowns).toEqual(["Rows exceed the retained allowance."]);
  expect(view.coverage.exhausted).toBe(true);
});

it("refuses other parent operations and Evidence without an APK subject", () => {
  const { parent } = fixture();
  expect(
    projectAnalysisView(
      { ...parent, operation: "inspect_android_package" },
      { kind: "summary" },
    ).ok,
  ).toBe(false);
  expect(
    projectAnalysisView({ ...parent, subject: null }, { kind: "summary" }).ok,
  ).toBe(false);
});
