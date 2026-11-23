import { z } from "zod";
import { managedMemberInspectionSchema } from "../managed/managedArtifact.js";
import { unresolvedDefinitionSchema } from "../managed/managedUnresolvedDefinitions.js";

const member = managedMemberInspectionSchema.shape;
const layouts = member.layout_declarations.unwrap().unwrap();

const rows = {
  types: member.types.element,
  exported_types: member.exported_types.unwrap().element,
  fields: member.fields.element,
  methods: member.methods.element,
  member_refs: member.member_refs.element,
  call_edges: member.call_edges.element,
  field_accesses: member.field_accesses.element,
  user_strings: member.user_strings.unwrap().shape.literals.element,
  unresolved_definitions: unresolvedDefinitionSchema,
  class_layouts: layouts.shape.classes.element,
  field_layouts: layouts.shape.fields.element,
};
const pageRequest = {
  kind: z.literal("managed-members"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
const namedRequest = {
  ...pageRequest,
  names: z
    .array(z.string())
    .exactOptional()
    .describe(
      "Exact name, called-method target_name or accessed field_name; empty matches nothing.",
    ),
};
const declaredRequest = {
  ...namedRequest,
  declaring_types: z
    .array(z.string())
    .exactOptional()
    .describe(
      "Exact defining type (fields/methods), parent type (member_refs), or target type (call_edges/field_accesses). Filters intersect.",
    ),
};

const fieldsOf = <S extends z.ZodEnum>(schema: S) =>
  z
    .array(schema)
    .exactOptional()
    .describe(
      "Project columns; source_index, row tokens and source offsets always remain. Omit for original full rows.",
    );

/** Filters precede paging; omitted fields preserve the existing full rows. */
export const managedMembersViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...namedRequest,
      collection: z.literal("types"),
      fields: fieldsOf(rows.types.keyof()),
    }),
    z.strictObject({
      ...namedRequest,
      collection: z.literal("exported_types"),
      fields: fieldsOf(rows.exported_types.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("fields"),
      fields: fieldsOf(rows.fields.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("methods"),
      fields: fieldsOf(rows.methods.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("member_refs"),
      fields: fieldsOf(rows.member_refs.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("call_edges"),
      fields: fieldsOf(rows.call_edges.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("field_accesses"),
      fields: fieldsOf(rows.field_accesses.keyof()),
    }),
    z.strictObject({
      ...pageRequest,
      collection: z.literal("user_strings"),
      fields: fieldsOf(rows.user_strings.keyof()),
    }),
    z.strictObject({
      ...pageRequest,
      collection: z.literal("unresolved_definitions"),
    }),
    z.strictObject({
      ...namedRequest,
      collection: z.literal("class_layouts"),
      fields: fieldsOf(rows.class_layouts.keyof()),
    }),
    z.strictObject({
      ...declaredRequest,
      collection: z.literal("field_layouts"),
      fields: fieldsOf(rows.field_layouts.keyof()),
    }),
  ],
);

// Filtered/projected rows always carry this coordinate. Historical unfiltered
// pages keep their original full-row shape without it.
const sourceIndex = { source_index: z.int().nonnegative().exactOptional() };
const rowsOf = <C extends string, S extends z.ZodObject>(
  collection: C,
  row: S,
) =>
  z.strictObject({
    collection: z.literal(collection),
    rows: z.array(row.extend(sourceIndex)),
    source_count: z.int().nonnegative().exactOptional(),
    unresolved_filter_rows: z.int().nonnegative().exactOptional(),
  });

export const managedMembersViewPageSchema = z.discriminatedUnion("collection", [
  rowsOf(
    "types",
    rows.types.partial().required({ token: true, row_offset: true }),
  ),
  rowsOf(
    "exported_types",
    rows.exported_types.partial().required({ token: true, row_offset: true }),
  ),
  rowsOf(
    "fields",
    rows.fields
      .partial()
      .required({ token: true, row_offset: true, declaring_type_token: true }),
  ),
  rowsOf(
    "methods",
    rows.methods
      .partial()
      .required({ token: true, row_offset: true, declaring_type_token: true }),
  ),
  rowsOf(
    "member_refs",
    rows.member_refs
      .partial()
      .required({ token: true, row_offset: true, parent_token: true }),
  ),
  rowsOf(
    "call_edges",
    rows.call_edges.partial().required({
      caller_token: true,
      il_offset: true,
      target_token: true,
      opcode: true,
    }),
  ),
  rowsOf(
    "field_accesses",
    rows.field_accesses.partial().required({
      method_token: true,
      il_offset: true,
      field_token: true,
      opcode: true,
    }),
  ),
  rowsOf(
    "user_strings",
    rows.user_strings.partial().required({ token: true, offset: true }),
  ),
  rowsOf(
    "class_layouts",
    rows.class_layouts.partial().required({
      token: true,
      row_offset: true,
      parent_row: true,
      type_token: true,
    }),
  ),
  rowsOf(
    "field_layouts",
    rows.field_layouts.partial().required({
      token: true,
      row_offset: true,
      field_row: true,
      field_token: true,
      declaring_type_token: true,
    }),
  ),
  z.strictObject({
    collection: z.literal("unresolved_definitions"),
    rows: z.array(rows.unresolved_definitions),
    source_count: z.int().nonnegative().exactOptional(),
    unresolved_filter_rows: z.int().nonnegative().exactOptional(),
  }),
]);

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
  selection: member.selection,
  method_rows: member.method_rows,
  unresolved_method_names_examined: z.boolean().exactOptional(),
  coverage: member.coverage,
  user_strings: z
    .strictObject({
      state: member.user_strings.unwrap().shape.state,
      issues: member.user_strings.unwrap().shape.issues,
    })
    .nullable(),
  layout_declarations: layouts
    .omit({ classes: true, fields: true })
    .nullable()
    .exactOptional(),
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
    unresolved_definitions: z.int().nonnegative().exactOptional(),
    class_layouts: nullableCount.exactOptional(),
    field_layouts: nullableCount.exactOptional(),
  }),
});

export const managedMembersViewContextSchema = z.strictObject({
  module: member.module.exactOptional(),
  signature_resolution: member.signature_resolution,
  nesting_read: member.nesting_read,
  identity_scope: member.identity_scope,
  selection: member.selection,
  method_rows: member.method_rows,
  source_metadata_status: member.metadata.shape.status,
  unresolved_module_name: member.metadata.shape.unresolved_module_name,
  source_coverage: member.coverage,
  unresolved_method_names_examined: z.boolean().exactOptional(),
});

export type ManagedMembersViewRequest = z.infer<
  typeof managedMembersViewRequestSchema
>;
export type ManagedMemberSummary = z.infer<typeof managedMemberSummarySchema>;
export type ManagedMemberCollection = ManagedMembersViewRequest["collection"];
export type ManagedMemberViewRow = z.infer<
  (typeof rows)[ManagedMemberCollection]
>;
