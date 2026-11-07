import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import type { JsonValue } from "../jsonValue.js";
import {
  analysisViewRequestSchema,
  androidAppFunctionsViewResultSchema,
  androidComponentsViewResultSchema,
  androidComponentSummaryViewResultSchema,
  androidPackageSummaryViewResultSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const component = (name: string, extra: Record<string, JsonValue> = {}) => ({
  kind: "activity",
  declared_name: name,
  name,
  exported: null,
  exported_default: null,
  permission: null,
  permission_source: "none",
  intent_filter_count: 0,
  actions: [] as string[],
  categories: [],
  foreground_service_type: null,
  authorities: null,
  target_activity: null,
  ...extra,
});
const report = (
  items = [
    component("example.One", {
      declared_name: ".One",
      exported: true,
      actions: ["VIEW"],
      declaration_index: 10,
      declaration_coverage: "complete",
    }),
    component("example.Boot", {
      kind: "receiver",
      exported_default: true,
      actions: ["BOOT"],
      declaration_index: 20,
    }),
    component("example.One", {
      declared_name: ".One",
      exported: false,
      actions: ["VIEW"],
      declaration_index: 30,
      declaration_coverage: "partial",
    }),
  ],
) => ({
  engine: {
    name: "jadx",
    version: null,
    artifact_sha256: "e".repeat(64),
    source_revision: null,
    worker_count: 1,
    heap_limit_mib: null,
  },
  package_name: "example",
  version_name: null,
  version_code: null,
  min_sdk: null,
  target_sdk: "35",
  permissions: [],
  manifest: {
    status: "complete",
    text: "<manifest/>",
    reported_total_bytes: 11,
  },
  components: {
    status: "partial",
    items,
    limitations: ["Producer component limit"],
  },
  class_count: 3,
  resource_count: 0,
  signature_verification: "not_performed",
});
const parent = (
  value: Record<string, JsonValue> = report(),
): AnalysisViewParent => {
  const evidence = createEvidence(
    { path: "/retained.apk", sha256: "a".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.7.1" },
    {
      operation: "inspect_android_package",
      parameters: {},
      result: value,
      limitations: ["Parent condition"],
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: value,
    subject: evidence.subject,
    limitations: evidence.limitations,
  };
};
const project = (source: AnalysisViewParent, view: unknown) => {
  const result = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse(view),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

it("keeps parent ordinals, duplicate declarations and coverage after filtering, paging and field selection", () => {
  const source = parent();
  const before = JSON.stringify(source);
  const page = androidComponentsViewResultSchema.parse(
    project(source, {
      kind: "android",
      facet: "components",
      names: [".One"],
      actions: ["VIEW"],
      kinds: ["activity"],
      offset: 1,
      limit: 1,
      fields: ["name", "declaration_index"],
    }),
  );
  expect(page.items).toEqual([
    {
      source_index: 2,
      name: "example.One",
      declaration_index: 30,
      declaration_coverage: "partial",
    },
  ]);
  expect(page.coverage).toMatchObject({
    total: 2,
    examined: 1,
    exhausted: true,
  });
  expect(page.source_components).toBe(3);
  expect(page.source_status).toBe("partial");
  expect(page.artifact).toEqual({
    path: "/retained.apk",
    sha256: "a".repeat(64),
  });
  expect(page.parent_evidence_id).toBe(source.evidenceId);
  expect(page.limitations).toEqual(
    expect.arrayContaining(["Parent condition", "Producer component limit"]),
  );
  expect(JSON.stringify(source)).toBe(before);
});

it("keeps omitted historical facts unknown even with empty or expanded field selections", () => {
  const source = parent(report([component("legacy.Class")]));
  for (const fields of [[], ["enabled", "intent_filters", "location"]]) {
    const page = androidComponentsViewResultSchema.parse(
      project(source, { kind: "android", facet: "components", fields }),
    );
    expect(page.items).toEqual([
      { source_index: 0, declaration_coverage: "unknown" },
    ]);
  }
});

it("counts explicit exported declarations separately from defaults and unknown historical coverage", () => {
  const source = parent();
  const summary = androidComponentSummaryViewResultSchema.parse(
    project(source, { kind: "android", facet: "component-summary" }),
  );
  expect(summary.summary).toEqual({
    matching_components: 3,
    by_kind: {
      activity: 2,
      "activity-alias": 0,
      service: 0,
      receiver: 1,
      provider: 0,
    },
    exported_declarations: { true: 1, false: 1, unknown: 1 },
    exported_defaults: { true: 1, false: 0, unknown: 2 },
    declaration_coverage: { complete: 1, partial: 1, unknown: 1 },
  });
  const explicit = androidComponentsViewResultSchema.parse(
    project(source, {
      kind: "android",
      facet: "components",
      exported: true,
      fields: [],
    }),
  );
  expect(explicit.items.map((row) => row.source_index)).toEqual([0]);
  const unknown = androidComponentSummaryViewResultSchema.parse(
    project(source, {
      kind: "android",
      facet: "component-summary",
      exported: null,
    }),
  );
  expect(unknown.summary.matching_components).toBe(1);
  expect(unknown.summary.exported_defaults.true).toBe(1);
});

it("preserves partial source coverage on empty filtered pages and never turns empty filters into all rows", () => {
  for (const selection of [
    { actions: [] },
    { names: [] },
    { kinds: [] },
    { actions: ["absent"] },
  ]) {
    const page = androidComponentsViewResultSchema.parse(
      project(parent(), { kind: "android", facet: "components", ...selection }),
    );
    expect(page.items).toEqual([]);
    expect(page.coverage.total).toBe(0);
    expect(page.source_status).toBe("partial");
    expect(page.unknowns.join(" ")).toContain("does not establish absence");
  }
});

it("bounds selected row serialization and lets field selection recover without changing the source", () => {
  const source = parent(
    report([
      component("large.Class", { process: "x".repeat(2 * 1024 * 1024) }),
    ]),
  );
  const wide = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse({ kind: "android", facet: "components" }),
  );
  expect(wide).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  if (wide.ok) throw new Error("Expected an oversized-row refusal");
  expect(projectAnalysisError(wide.error).remediation.action).toContain(
    "select fewer fields",
  );
  const small = androidComponentsViewResultSchema.parse(
    project(source, { kind: "android", facet: "components", fields: ["name"] }),
  );
  expect(small.items).toEqual([
    { source_index: 0, name: "large.Class", declaration_coverage: "unknown" },
  ]);
});

it("returns a resumable byte-limited page instead of silently omitting later rows", () => {
  const source = parent(
    report(
      Array.from({ length: 3 }, (_, index) =>
        component(`large.${index}`, { process: "x".repeat(400_000) }),
      ),
    ),
  );
  const first = androidComponentsViewResultSchema.parse(
    project(source, {
      kind: "android",
      facet: "components",
      limit: 3,
      fields: ["process"],
    }),
  );
  expect(first.byte_limited).toBe(true);
  expect(first.items.map((row) => row.source_index)).toEqual([0, 1]);
  expect(first.coverage).toMatchObject({
    total: 3,
    next_offset: 2,
    exhausted: false,
  });
  const last = androidComponentsViewResultSchema.parse(
    project(source, {
      kind: "android",
      facet: "components",
      offset: 2,
      limit: 3,
      fields: ["process"],
    }),
  );
  expect(last.items.map((row) => row.source_index)).toEqual([2]);
  expect(last.coverage.exhausted).toBe(true);
});

it("projects AppFunctions summary counts and facet views while preserving historical unavailable defaults", () => {
  const legacySource = parent();
  const legacySummary = androidPackageSummaryViewResultSchema.parse(
    project(legacySource, { kind: "summary" }),
  );
  expect(legacySummary.summary.app_functions.status).toBe("unavailable");
  expect(legacySummary.summary.app_functions_summary).toEqual({
    service_count: 0,
    system_bound_service_count: 0,
    schema_count: 0,
    function_count: 0,
  });
  const legacyFacet = androidAppFunctionsViewResultSchema.parse(
    project(legacySource, { kind: "android", facet: "app-functions" }),
  );
  expect(legacyFacet.source_status).toBe("unavailable");
  expect(legacyFacet.unknowns.join(" ")).toContain("do not establish absence");

  const populatedSource = parent({
    ...report(),
    app_functions: {
      status: "complete",
      services: [
        {
          declared_name: ".AgentAppFunctionService",
          name: "example.AgentAppFunctionService",
          declaration_index: 0,
          location: { line: 4, column: 6, offset: 96 },
          exported: true,
          permission: "android.permission.BIND_APP_FUNCTION_SERVICE",
          binds_system_permission: true,
          declares_service_action: true,
          schema_pointers: [
            {
              source: "property",
              name: "android.app.appfunctions",
              value: "assets/app_functions_v2.xml",
              resource: null,
              resolved_asset_path: "assets/app_functions_v2.xml",
              location: { line: 5, column: 8, offset: 140 },
            },
          ],
        },
      ],
      schemas: [
        {
          path: "assets/app_functions_v2.xml",
          source_path: "assets/app_functions_v2.xml",
          sha256: "b".repeat(64),
          size: 256,
          status: "complete",
          functions: [
            {
              id: "example#createNote",
              schema_name: "createNote",
              schema_category: "notes",
              schema_version: "2",
              enabled_by_default: true,
            },
            {
              id: "example#listNotes",
              schema_name: "listNotes",
              schema_category: "notes",
              schema_version: "2",
              enabled_by_default: false,
            },
          ],
          limitations: [],
        },
      ],
      limitations: [
        "Static AppFunction declarations and XML schema assets do not establish runtime registration, caller authorization, or execution.",
      ],
    },
  });
  const populatedSummary = androidPackageSummaryViewResultSchema.parse(
    project(populatedSource, { kind: "summary" }),
  );
  expect(populatedSummary.summary.app_functions_summary).toEqual({
    service_count: 1,
    system_bound_service_count: 1,
    schema_count: 1,
    function_count: 2,
  });
  const populatedFacet = androidAppFunctionsViewResultSchema.parse(
    project(populatedSource, { kind: "android", facet: "app-functions" }),
  );
  expect(populatedFacet.source_status).toBe("complete");
  expect(populatedFacet.summary).toEqual({
    service_count: 1,
    system_bound_service_count: 1,
    schema_count: 1,
    function_count: 2,
  });
  expect(populatedFacet.app_functions.schemas[0]?.functions).toHaveLength(2);
  expect(populatedFacet.coverage).toMatchObject({
    examined: 2,
    total: 2,
    exhausted: true,
  });
});
