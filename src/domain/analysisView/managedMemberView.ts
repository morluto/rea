import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "../managed/managedArtifact.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { managedViewIdentityUnknowns } from "./managedArtifactView.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";

const member = managedMemberInspectionSchema.shape;

/** Original member rows; offsets count entries in the returned parent collection. */
export const managedMembersViewRequestSchema = z.strictObject({
  kind: z.literal("managed-members"),
  collection: z.enum([
    "types",
    "exported_types",
    "fields",
    "methods",
    "member_refs",
    "call_edges",
    "field_accesses",
    "user_strings",
  ]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
});

const rowsOf = <C extends string, S extends z.ZodArray>(
  collection: C,
  rows: S,
) => z.strictObject({ collection: z.literal(collection), rows });

/**
 * Rows of one collection, keyed by that collection: several row schemas accept
 * each other's rows after stripping keys, so no union may pick one by order.
 */
export const managedMembersViewPageSchema = z.discriminatedUnion("collection", [
  rowsOf("types", member.types),
  rowsOf("exported_types", member.exported_types.unwrap().unwrap()),
  rowsOf("fields", member.fields),
  rowsOf("methods", member.methods),
  rowsOf("member_refs", member.member_refs),
  rowsOf("call_edges", member.call_edges),
  rowsOf("field_accesses", member.field_accesses),
  rowsOf("user_strings", member.user_strings.unwrap().unwrap().shape.literals),
]);

type ManagedMembersViewPage = z.infer<typeof managedMembersViewPageSchema>;

const nullableCount = z.int().nonnegative().nullable();

/** Keep identity, selection and coverage; member collections remain retained. */
export const managedMemberSummarySchema = z.strictObject({
  signature_resolution: member.signature_resolution,
  nesting_read: member.nesting_read,
  artifact: member.artifact,
  module: member.module,
  assembly: member.assembly,
  metadata: member.metadata,
  identity_scope: member.identity_scope,
  selection: member.selection.unwrap(),
  method_rows: member.method_rows,
  coverage: member.coverage,
  user_strings: z
    .strictObject({
      state: member.user_strings.unwrap().unwrap().shape.state,
      issues: member.user_strings.unwrap().unwrap().shape.issues,
    })
    .nullable(),
  limitations: member.limitations,
  reported_counts: z.strictObject({
    types: z.int().nonnegative(),
    exported_types: nullableCount,
    fields: z.int().nonnegative(),
    methods: z.int().nonnegative(),
    member_refs: z.int().nonnegative(),
    call_edges: z.int().nonnegative(),
    field_accesses: z.int().nonnegative(),
    user_strings: nullableCount,
  }),
});

export const managedMembersViewContextSchema = z.strictObject({
  signature_resolution: member.signature_resolution,
  nesting_read: member.nesting_read,
  identity_scope: member.identity_scope,
  selection: member.selection.unwrap(),
  method_rows: member.method_rows,
  source_metadata_status: member.metadata.shape.status,
  source_coverage: member.coverage,
});

type ManagedMembersViewRequest = z.infer<
  typeof managedMembersViewRequestSchema
>;
type MemberCollection = ManagedMembersViewRequest["collection"];

const slice = <C extends MemberCollection, T>(
  collection: C,
  rows: readonly T[] | null | undefined,
  { offset, limit }: { readonly offset: number; readonly limit: number },
) =>
  rows == null
    ? null
    : {
        page: { collection, rows: rows.slice(offset, offset + limit) },
        total: rows.length,
      };

/** One page of a collection, or null when the parent never examined it. */
const collectionPage = (
  report: ManagedMemberInspection,
  view: ManagedMembersViewRequest,
): { readonly page: ManagedMembersViewPage; readonly total: number } | null => {
  const { collection } = view;
  switch (collection) {
    case "types":
      return slice(collection, report.types, view);
    case "exported_types":
      return slice(collection, report.exported_types, view);
    case "fields":
      return slice(collection, report.fields, view);
    case "methods":
      return slice(collection, report.methods, view);
    case "member_refs":
      return slice(collection, report.member_refs, view);
    case "call_edges":
      return slice(collection, report.call_edges, view);
    case "field_accesses":
      return slice(collection, report.field_accesses, view);
    case "user_strings":
      return slice(collection, report.user_strings?.literals, view);
  }
};

/** The shared owner proves immutable source identity before retaining normalized facts. */
const parseMemberReport = createAnalysisViewResultReader(
  managedMemberInspectionSchema,
);

/** Everything but the member collections, which are replaced by their counts. */
const summarizeMembers = (
  report: ManagedMemberInspection,
): z.infer<typeof managedMemberSummarySchema> => {
  const {
    types,
    exported_types,
    fields,
    methods,
    member_refs,
    call_edges,
    field_accesses,
    user_strings,
    ...identity
  } = report;
  return {
    ...identity,
    user_strings:
      user_strings === null
        ? null
        : { state: user_strings.state, issues: user_strings.issues },
    reported_counts: {
      types: types.length,
      exported_types: exported_types?.length ?? null,
      fields: fields.length,
      methods: methods.length,
      member_refs: member_refs.length,
      call_edges: call_edges.length,
      field_accesses: field_accesses.length,
      user_strings: user_strings?.literals.length ?? null,
    },
  };
};

/** Project authenticated member Evidence without reading a path or invoking a provider. */
export const projectManagedMemberView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "managed-members")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Managed member inspection supports summary and managed-members views.",
        },
      ]),
    );
  const parsed = parseMemberReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_managed_members" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      "Collection counts and pages cover producer-returned rows; member completeness remains the original coverage, not an absence claim about unreturned rows.",
      ...(report.selection === null
        ? []
        : [
            "Exported types and member references cover the whole assembly; the other collections cover only the selected declaring types.",
          ]),
      ...managedViewIdentityUnknowns(
        parent,
        report.identity_scope.requires_mvid,
      ),
    ],
  };
  if (view.kind === "summary") {
    const summary = summarizeMembers(report);
    const total = Object.values(summary.reported_counts).reduce<number>(
      (sum, count) => sum + (count ?? 0),
      0,
    );
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary,
      coverage: completeWithinViewCoverage(total, total),
    });
  }
  const selected = collectionPage(report, view);
  if (selected === null)
    return err(
      analysisViewInputError([
        {
          path: ["view", "collection"],
          reason: "invalid_value",
          message: `The parent Evidence did not examine ${view.collection}; repeat inspect_managed_members with the current runtime to record it.`,
        },
      ]),
    );
  const { page, total } = selected;
  return ok({
    kind: "managed-members",
    view,
    page,
    ...shared,
    signature_resolution: report.signature_resolution,
    nesting_read: report.nesting_read,
    identity_scope: report.identity_scope,
    selection: report.selection,
    method_rows: report.method_rows,
    source_metadata_status: report.metadata.status,
    source_coverage:
      view.collection === "user_strings" && report.user_strings !== null
        ? {
            state: report.user_strings.state,
            issues: report.user_strings.issues,
          }
        : report.coverage,
    coverage: pageViewCoverage(view.offset, page.rows.length, total),
  });
};
