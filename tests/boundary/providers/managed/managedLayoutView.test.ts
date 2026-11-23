import { expect, it } from "vitest";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../../../../src/dotnet/ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { projectManagedMemberView } from "../../../../src/domain/analysisView/managedMemberView.js";
import { managedMembersViewRequestSchema } from "../../../../src/domain/analysisView/managedMemberViewSchemas.js";
import type { AnalysisViewParent } from "../../../../src/domain/analysisView/analysisViewParent.js";

const report = (invalid = false) => {
  const bytes = buildManagedPeFixture({
    typeFlags: [0x100011],
    classLayouts: [[0, 16, 1]],
    fieldLayouts: invalid
      ? [
          [4, 1],
          [8, 0],
        ]
      : [[4, 1]],
  });
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};
const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_managed_members",
  normalizedResult,
  sealedResult: true,
  limitations: [],
});

it("summarizes layout counts and independent coverage without copying rows", () => {
  const source = report(true);
  const result = projectManagedMemberView(parent(source), { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: {
      layout_declarations: {
        state: "partial",
        issues: source.layout_declarations?.issues,
      },
      reported_counts: { class_layouts: 1, field_layouts: 2 },
    },
  });
  if (!("summary" in result.value)) throw new Error("Expected summary");
  expect(result.value.summary.layout_declarations).not.toHaveProperty(
    "classes",
  );
});

it("projects class layout while retaining raw owner and row coordinates", () => {
  const result = projectManagedMemberView(
    parent(report()),
    managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "class_layouts",
      names: ["Fixture.Program"],
      fields: ["class_size"],
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    source_coverage: { state: "complete", issues: [] },
    page: {
      collection: "class_layouts",
      source_count: 1,
      rows: [
        {
          source_index: 0,
          token: "0x0f000001",
          row_offset: expect.any(Number),
          parent_row: 1,
          type_token: "0x02000001",
          class_size: 16,
        },
      ],
    },
  });
  if (!("page" in result.value)) throw new Error("Expected page");
  expect(result.value.page.rows[0]).not.toHaveProperty("packing_size");
});

it("keeps unknown filtered field names and partial layout coverage visible", () => {
  const result = projectManagedMemberView(
    parent(report(true)),
    managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "field_layouts",
      names: ["counter"],
      declaring_types: ["Fixture.Program"],
      fields: ["offset_bytes"],
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    source_coverage: { state: "partial" },
    page: {
      collection: "field_layouts",
      source_count: 2,
      unresolved_filter_rows: 1,
      rows: [
        {
          source_index: 0,
          token: "0x10000001",
          field_row: 1,
          field_token: "0x04000001",
          declaring_type_token: "0x02000001",
          offset_bytes: 4,
        },
      ],
    },
  });
});

it.each(["omitted", "null"] as const)(
  "does not turn an %s historical layout into an empty inventory",
  (kind) => {
    const source = report();
    if (kind === "omitted") delete source.layout_declarations;
    else source.layout_declarations = null;
    const page = projectManagedMemberView(
      parent(source),
      managedMembersViewRequestSchema.parse({
        kind: "managed-members",
        collection: "field_layouts",
      }),
    );
    expect(page.ok).toBe(false);
    const summary = projectManagedMemberView(parent(source), {
      kind: "summary",
    });
    if (!summary.ok) throw summary.error;
    if (!("summary" in summary.value)) throw new Error("Expected summary");
    if (kind === "omitted") {
      expect(summary.value.summary).not.toHaveProperty("layout_declarations");
      expect(summary.value.summary.reported_counts).not.toHaveProperty(
        "field_layouts",
      );
    } else
      expect(summary.value.summary.reported_counts.field_layouts).toBeNull();
  },
);
