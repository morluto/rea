import { expect, it } from "vitest";
import { MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import { freezeOwnedJsonTreeSnapshot } from "../immutableJson.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { projectAnalysisView } from "./analysisView.js";
import { managedMemberInspectionSchema } from "../managed/managedArtifact.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  managedMembersViewRequestSchema,
  managedMembersViewPageSchema,
} from "./managedMemberViewSchemas.js";
import { projectManagedMemberView } from "./managedMemberView.js";

const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_managed_members",
  normalizedResult,
  sealedResult: true,
  limitations: [],
});

it("revalidates mutable managed facts despite a sealed flag and shallow freeze", () => {
  const source = managedMemberInspectionSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.normalized_result,
  );
  Object.freeze(source);
  const input = parent(source);
  expect(projectManagedMemberView(input, { kind: "summary" }).ok).toBe(true);
  Object.assign(source.coverage, { state: "invalid" });
  expect(projectManagedMemberView(input, { kind: "summary" })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("keeps unexamined collections unknown while normalizing immutable managed parents", () => {
  const complete = managedMemberInspectionSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.normalized_result,
  );
  const unexamined = {
    ...complete,
    signature_resolution: null,
    exported_types: null,
    user_strings: null,
    fields: [],
    methods: [],
    member_refs: [],
    call_edges: [],
    field_accesses: [],
  };
  const input = parent(freezeOwnedJsonTreeSnapshot(unexamined));
  const coordinates = managedMembersViewRequestSchema.parse({
    kind: "managed-members",
    collection: "unresolved_definitions",
    offset: 0,
    limit: 1,
  });
  expect(projectManagedMemberView(input, coordinates)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(projectManagedMemberView(input, { kind: "summary" })).toMatchObject({
      ok: true,
      value: {
        summary: {
          signature_resolution: null,
          reported_counts: { exported_types: null, user_strings: null },
        },
      },
    });
  }
  const { nesting_read: _nesting, ...withoutNesting } = complete;
  expect(
    projectManagedMemberView(parent(withoutNesting), { kind: "summary" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

const methodFacts = () => {
  const report = managedMemberInspectionSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.normalized_result,
  );
  const template = report.methods[0];
  if (template === undefined) throw new Error("Method fixture is missing");
  report.methods = [
    { ...template, name: "Keep", declaring_type: "Other.Type" },
    {
      ...template,
      token: "0x06000002",
      name: "Keep",
      declaring_type: "Exact.Type",
    },
    {
      ...template,
      token: "0x06000003",
      name: "Skip",
      declaring_type: "Exact.Type",
    },
    {
      ...template,
      token: "0x06000004",
      name: "Keep",
      declaring_type: "Exact.Type",
    },
  ];
  return report;
};

it("intersects exact filters before paging and preserves identity while omitting IL", () => {
  const report = methodFacts();
  const before = JSON.stringify(report);
  const request = managedMembersViewRequestSchema.parse({
    kind: "managed-members",
    collection: "methods",
    names: ["Keep", "Keep"],
    declaring_types: ["Exact.Type"],
    fields: ["name"],
    offset: 1,
    limit: 1,
  });
  const result = projectManagedMemberView(
    parent(freezeOwnedJsonTreeSnapshot(report)),
    request,
  );
  if (!result.ok) throw result.error;
  if (!("page" in result.value)) throw new Error("Wrong view");
  expect(result.value.page).toEqual({
    collection: "methods",
    source_count: 4,
    unresolved_filter_rows: 0,
    rows: [
      {
        token: "0x06000004",
        row_offset: 128,
        declaring_type_token: "0x02000001",
        name: "Keep",
        source_index: 3,
      },
    ],
  });
  expect(managedMembersViewPageSchema.parse(result.value.page)).toEqual(
    result.value.page,
  );
  expect(result.value).toMatchObject({
    module: report.module,
    identity_scope: report.identity_scope,
    source_coverage: report.coverage,
    coverage: { total: 2, examined: 1, next_offset: null },
  });
  expect(JSON.stringify(report)).toBe(before);
});

it("keeps unresolved exact-filter candidates unknown under complete and partial coverage", () => {
  for (const state of ["complete", "partial"] as const) {
    const report = methodFacts();
    report.coverage = { state, issues: [] };
    const method = report.methods[1];
    if (method === undefined) throw new Error("Method fixture is missing");
    report.methods = [
      method,
      {
        ...method,
        token: "0x06000005",
        declaring_type: null,
        declaring_type_token: null,
      },
      { ...method, name: "Mismatch", declaring_type: null },
    ];
    const result = projectManagedMemberView(
      parent(report),
      managedMembersViewRequestSchema.parse({
        kind: "managed-members",
        collection: "methods",
        names: ["Keep"],
        declaring_types: ["Exact.Type"],
        fields: [],
      }),
    );
    if (!result.ok) throw result.error;
    if (!("page" in result.value)) throw new Error("Wrong view");
    expect(result.value).toMatchObject({
      source_coverage: { state },
      coverage: { total: 1 },
      page: {
        source_count: 3,
        unresolved_filter_rows: 1,
        rows: [{ token: "0x06000002", source_index: 0 }],
      },
    });
    expect(result.value.page.rows[0]).not.toHaveProperty("body");
  }
});

it("distinguishes empty selectors from omitted selectors and pages projections without filtering", () => {
  const report = methodFacts();
  for (const names of [[], ["keep"]]) {
    const result = projectManagedMemberView(
      parent(report),
      managedMembersViewRequestSchema.parse({
        kind: "managed-members",
        collection: "methods",
        names,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      coverage: { total: 0 },
      page: { rows: [], unresolved_filter_rows: 0 },
    });
  }
  const result = projectManagedMemberView(
    parent(report),
    managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "methods",
      fields: [],
      offset: 3,
      limit: 2,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    coverage: { total: 4, examined: 1 },
    page: { source_count: 4, rows: [{ source_index: 3, token: "0x06000004" }] },
  });
  const full = projectManagedMemberView(
    parent(report),
    managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "methods",
      offset: 1,
      limit: 2,
    }),
  );
  if (!full.ok) throw full.error;
  expect(full.value).toMatchObject({
    page: { collection: "methods", rows: report.methods.slice(1, 3) },
  });
  if (!("page" in full.value)) throw new Error("Wrong view");
  expect(full.value.page.rows).toEqual(report.methods.slice(1, 3));
});

it("rejects unsupported selectors and fields instead of silently ignoring caller choices", () => {
  for (const view of [
    { collection: "methods", fields: ["target_name"] },
    { collection: "user_strings", names: ["text"] },
    { collection: "types", declaring_types: ["Outer"] },
  ])
    expect(
      managedMembersViewRequestSchema.safeParse({
        kind: "managed-members",
        ...view,
      }).success,
    ).toBe(false);
});

it("does not add omitted columns and requires the IL offset of every edge row", () => {
  const types = {
    collection: "types",
    rows: [{ token: "0x02000001", row_offset: 32, source_index: 0 }],
  };
  expect(managedMembersViewPageSchema.parse(types)).toEqual(types);
  const edge = {
    caller_token: "0x06000001",
    opcode: "call",
    target_token: "0x0a000001",
    source_index: 0,
  };
  const calls = managedMembersViewPageSchema.parse({
    collection: "call_edges",
    rows: [{ ...edge, il_offset: null }],
  });
  expect(calls.rows[0]).not.toHaveProperty("target_identity_sha256");
  expect(calls.rows[0]).not.toHaveProperty("target_declaring_type");
  expect(calls.rows[0]).not.toHaveProperty("generic_method_token");
  expect(
    managedMembersViewPageSchema.safeParse({
      collection: "call_edges",
      rows: [edge],
    }).success,
  ).toBe(false);
});

it("preserves call-edge column omission and the sealed view digest", () => {
  const report = methodFacts();
  report.call_edges = [
    {
      caller_token: "0x06000001",
      il_offset: 0,
      target_identity_sha256: null,
      target_row_resolved: true,
      caller: "Caller",
      opcode: "call",
      target_token: "0x2b000001",
      target_kind: "method-spec",
      generic_method_token: "0x06000002",
      target_name: "Helper",
      target_declaring_type: "Exact.Type",
    },
  ];
  for (const fields of [[], ["generic_method_token"], undefined]) {
    const request = managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "call_edges",
      ...(fields === undefined ? {} : { fields }),
    });
    const result = projectAnalysisView(parent(report), request);
    if (!result.ok) throw result.error;
    if (result.value.kind !== "managed-members") throw new Error("Wrong view");
    if (result.value.page.collection !== "call_edges")
      throw new Error("Wrong collection");
    const row = result.value.page.rows[0];
    expect(row).toBeDefined();
    if (fields?.length === 0)
      expect(row).not.toHaveProperty("generic_method_token");
    else
      expect(row).toHaveProperty("generic_method_token", "0x06000002");
    const { view_digest, ...content } = result.value;
    expect(view_digest).toBe(digestCanonicalValue(content, "Analysis view"));
  }
  const historical = {
    ...report,
    call_edges: report.call_edges.map(
      ({ generic_method_token: _token, ...edge }) => edge,
    ),
  };
  expect(managedMemberInspectionSchema.parse(historical).call_edges[0])
    .toHaveProperty("generic_method_token", null);
});

it("filters relationship endpoints from recorded facts rather than caller display text", () => {
  const report = methodFacts();
  const method = report.methods[0];
  if (method === undefined) throw new Error("Method fixture is missing");
  report.call_edges = [
    {
      caller_token: "0x06000001",
      il_offset: 0,
      target_identity_sha256: null,
      target_row_resolved: false,
      caller: "Unrelated.Caller",
      opcode: "call",
      target_token: "0x0a000001",
      target_kind: "member-ref",
      generic_method_token: null,
      target_name: "Target",
      target_declaring_type: "Exact.Type",
    },
    {
      caller_token: "0x06000002",
      il_offset: 0,
      target_identity_sha256: null,
      target_row_resolved: false,
      caller: "Exact.Type.Target",
      opcode: "call",
      target_token: "0x0a000002",
      target_kind: "member-ref",
      generic_method_token: null,
      target_name: "Other",
      target_declaring_type: "Other.Type",
    },
  ];
  report.field_accesses = [
    {
      method_token: "0x06000001",
      il_offset: 0,
      target_identity_sha256: null,
      target_row_resolved: false,
      method: "Unrelated.Caller",
      opcode: "ldfld",
      field_token: "0x04000001",
      field_name: "Target",
      field_declaring_type: "Exact.Type",
    },
    {
      method_token: "0x06000002",
      il_offset: 0,
      target_identity_sha256: null,
      target_row_resolved: false,
      method: "Exact.Type.Target",
      opcode: "ldfld",
      field_token: "0x04000002",
      field_name: "Other",
      field_declaring_type: "Other.Type",
    },
  ];
  report.member_refs = [
    {
      token: "0x0a000001",
      row_offset: 256,
      parent_token: "0x01000001",
      parent_name: "Exact.Type",
      name: "Target",
      signature: method.signature,
    },
    {
      token: "0x0a000002",
      row_offset: 272,
      parent_token: "0x01000002",
      parent_name: "Other.Type",
      name: "Target",
      signature: method.signature,
    },
  ];
  for (const collection of [
    "call_edges",
    "field_accesses",
    "member_refs",
  ] as const) {
    const result = projectManagedMemberView(
      parent(report),
      managedMembersViewRequestSchema.parse({
        kind: "managed-members",
        collection,
        names: ["Target"],
        declaring_types: ["Exact.Type"],
        fields: [],
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      coverage: { total: 1 },
      page: {
        source_count: 2,
        unresolved_filter_rows: 0,
        rows: [{ source_index: 0 }],
      },
    });
  }
});

it("preserves paging and unknown counts on first and repeated sealed-parent queries", () => {
  const report = methodFacts();
  const method = report.methods[1];
  if (method === undefined) throw new Error("Method fixture is missing");
  report.methods.splice(2, 0, {
    ...method,
    token: "0x06000005",
    declaring_type: null,
    declaring_type_token: null,
  });
  const sealed = parent(freezeOwnedJsonTreeSnapshot(report));
  const cases = [
    {
      filter: { declaring_types: ["Exact.Type"] },
      offset: 1,
      total: 3,
      unresolved: 1,
      indices: [3, 4],
    },
    {
      filter: { declaring_types: [] },
      offset: 0,
      total: 0,
      unresolved: 0,
      indices: [],
    },
    {
      filter: { declaring_types: ["Exact.Type", "Other.Type"] },
      offset: 1,
      total: 4,
      unresolved: 1,
      indices: [1, 3],
    },
    {
      filter: {
        names: ["Keep"],
        declaring_types: ["Exact.Type", "Other.Type"],
      },
      offset: 1,
      total: 3,
      unresolved: 1,
      indices: [1, 4],
    },
  ];
  for (const { filter, offset, total, unresolved, indices } of cases) {
    const view = managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "methods",
      ...filter,
      fields: [],
      offset,
      limit: 2,
    });
    for (let run = 0; run < 2; run += 1) {
      const result = projectManagedMemberView(sealed, view);
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        coverage: { total },
        page: {
          unresolved_filter_rows: unresolved,
          rows: indices.map((source_index) => ({ source_index })),
        },
      });
    }
  }
});
