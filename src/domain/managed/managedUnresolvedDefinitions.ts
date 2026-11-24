import { z } from "zod";
import type {
  ManagedMemberInspection,
  ManagedParseIssue,
} from "./managedArtifact.js";
import {
  ManagedHeapAmbiguityFailure,
  retainManagedValueFailure,
} from "./managedReaderFailure.js";

const uint32 = z.int().min(0).max(0xffff_ffff);
const typeToken = z.string().regex(/^0x02[0-9a-f]{6}$/u);
const methodToken = z.string().regex(/^0x06[0-9a-f]{6}$/u);

const failedDefinitionFieldSchema = z.strictObject({
  field: z.enum(["Name", "Namespace"]),
  field_offset: z.int().nonnegative(),
  heap_index: uint32,
  reason: z.enum([
    "ambiguous-string-heap",
    "invalid-heap-index",
    "invalid-string",
    "empty-required-name",
  ]),
});

const coordinates = {
  row_offset: z.int().nonnegative(),
  failed_fields: z.array(failedDefinitionFieldSchema).min(1).max(2),
};

export const unresolvedDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("TypeDef"),
    token: typeToken,
    ...coordinates,
  }),
  z.strictObject({
    kind: z.literal("MethodDef"),
    token: methodToken,
    ...coordinates,
    declaring_type_token: typeToken.nullable(),
    rva: uint32.describe(
      "Raw MethodDef RVA, including zero; a nonzero value does not establish a file-backed body.",
    ),
  }),
]);

export const unresolvedDefinitionsSchema = z.strictObject({
  rows: z
    .array(unresolvedDefinitionSchema)
    .describe(
      "Physical TypeDef coordinates from the assembly-wide name scan, then MethodDef coordinates within the source method interval and selected declaring types. These rows carry local coordinates only and do not satisfy nominal selectors.",
    ),
  method_names_examined: z
    .boolean()
    .describe(
      "Whether method names were examined within the recorded method interval and any exact declaring-type selection. False means capacity recovery retained only the type coordinates.",
    ),
});

export type FailedDefinitionField = z.infer<typeof failedDefinitionFieldSchema>;
export type UnresolvedDefinition = z.infer<typeof unresolvedDefinitionSchema>;

/** Keep the checked field coordinate even when its heap value is unreadable. */
export const readDefinitionField = (
  operation: () => string,
  issues: ManagedParseIssue[],
  field: FailedDefinitionField["field"],
  offset: number,
  heapIndex: number,
): string | FailedDefinitionField => {
  try {
    return operation();
  } catch (cause: unknown) {
    const failure = retainManagedValueFailure(cause, issues);
    let reason: FailedDefinitionField["reason"];
    if (failure instanceof ManagedHeapAmbiguityFailure)
      reason = "ambiguous-string-heap";
    else
      switch (failure.issue.code) {
        case "invalid-heap-index":
        case "invalid-string":
          reason = failure.issue.code;
          break;
        case "invalid-row":
          reason = "empty-required-name";
          break;
        default:
          throw failure;
      }
    return { field, field_offset: offset, heap_index: heapIndex, reason };
  }
};

const tokenRow = (token: string): number => Number.parseInt(token.slice(4), 16);

export const validateUnresolvedDefinitions = (
  report: ManagedMemberInspection,
  context: z.RefinementCtx,
): void => {
  const projection = report.unresolved_definitions;
  if (projection === undefined) return;
  const fail = (path: (string | number)[], message: string) =>
    context.addIssue({
      code: "custom",
      path: ["unresolved_definitions", ...path],
      message,
    });
  if (
    projection.method_names_examined !==
      (report.signature_resolution !== null) ||
    (projection.method_names_examined && report.method_rows === null)
  )
    fail(
      ["method_names_examined"],
      "Method name coverage must agree with member examination and the recorded MethodDef interval.",
    );
  if (projection.rows.length === 0) return;
  if (
    report.coverage.state !== "partial" ||
    report.metadata.status !== "partial"
  )
    fail(
      ["rows"],
      "Unresolved definitions require partial metadata and coverage.",
    );

  const typeTokens = new Set(report.types.map(({ token }) => token));
  const methodTokens = new Set(report.methods.map(({ token }) => token));
  const { byte_length: byteLength } = report.artifact;
  const counts = report.metadata.table_row_counts;
  let previous = "";
  for (const [index, row] of projection.rows.entries()) {
    const rid = tokenRow(row.token);
    if (
      rid < 1 ||
      rid > (counts[row.kind] ?? 0) ||
      row.token <= previous ||
      (row.kind === "TypeDef" ? typeTokens : methodTokens).has(row.token)
    )
      fail(
        ["rows", index, "token"],
        "Expected a unique, in-table token in order, distinct from named rows.",
      );
    previous = row.token;
    if (row.kind === "MethodDef") {
      const interval = report.method_rows;
      if (
        !projection.method_names_examined ||
        interval === null ||
        rid <= interval.offset ||
        rid - interval.offset > interval.count
      )
        fail(
          ["rows", index, "token"],
          "MethodDef coordinate is outside the examined interval.",
        );
      const owner = row.declaring_type_token;
      if (
        (owner !== null &&
          (tokenRow(owner) < 1 || tokenRow(owner) > (counts.TypeDef ?? 0))) ||
        (report.selection !== null &&
          (owner === null || !typeTokens.has(owner)))
      )
        fail(
          ["rows", index, "declaring_type_token"],
          "MethodDef owner must be an admitted TypeDef within the applicable selection.",
        );
    }
    const fields = new Set<string>();
    let previousFieldOffset = row.row_offset;
    for (const [column, fact] of row.failed_fields.entries()) {
      if (
        (row.kind === "MethodDef" && fact.field !== "Name") ||
        fields.has(fact.field) ||
        fact.field_offset <= previousFieldOffset ||
        fact.field_offset > byteLength - 2 ||
        (fact.reason === "empty-required-name" && fact.field !== "Name") ||
        (fact.heap_index === 0 && fact.reason !== "empty-required-name")
      )
        fail(
          ["rows", index, "failed_fields", column],
          "Expected a distinct failed name column within the checked row and artifact.",
        );
      fields.add(fact.field);
      previousFieldOffset = fact.field_offset;
    }
  }
};
