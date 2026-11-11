import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { apiContractArtifactSchema } from "./apiContract.js";

/** Parser representation policies, not GraphQL language limits. */
export const GRAPHQL_CONTRACT_LIMITS = {
  lexicalTokens: 262144,
  comments: 65536,
  astDepth: 128,
} as const;
export const GRAPHQL_CONTRACT_PROFILE = "graphql-sdl-field-bindings-v1";

export const graphqlSourceSchema = z.strictObject({
  role: z.enum(["schema", "operations"]),
  sha256: digestSchema,
  start_utf16: z.int().nonnegative(),
  end_utf16: z.int().nonnegative(),
  line: z.int().positive(),
  column: z.int().positive(),
});
export const graphqlTypeSchema = z.strictObject({
  type_id: prefixedDigestSchema("graphql_type"),
  name: z.string(),
  kind: z.enum([
    "object",
    "interface",
    "input-object",
    "scalar",
    "enum",
    "union",
  ]),
  extension: z.boolean(),
  interfaces: z.array(z.string()),
  members: z.array(z.string()),
  source: graphqlSourceSchema,
});
export const graphqlFieldSchema = z.strictObject({
  field_id: prefixedDigestSchema("graphql_field"),
  field_key: z.string(),
  owner_type_id: graphqlTypeSchema.shape.type_id,
  owner_type_name: z.string(),
  kind: z.enum(["output", "input"]),
  name: z.string(),
  type_ref: z.string(),
  named_type: z.string(),
  source: graphqlSourceSchema,
});
export const graphqlDefinitionSchema = z.strictObject({
  definition_id: prefixedDigestSchema("graphql_definition"),
  kind: z.enum(["query", "mutation", "subscription", "fragment"]),
  name: z.string().nullable(),
  type_condition: z.string().nullable(),
  source: graphqlSourceSchema,
});
export const graphqlReferenceSchema = z.strictObject({
  reference_id: prefixedDigestSchema("graphql_reference"),
  definition_id: graphqlDefinitionSchema.shape.definition_id,
  parent_reference_id: prefixedDigestSchema("graphql_reference").nullable(),
  field_name: z.string(),
  response_key: z.string(),
  parent_type_name: z.string().nullable(),
  schema_field_id: graphqlFieldSchema.shape.field_id.nullable(),
  result_type: z.string().nullable(),
  state: z.enum(["resolved", "model-only", "unknown"]),
  reason: z
    .enum([
      "schema-model-unavailable",
      "parent-type-unavailable",
      "unknown-field",
      "no-sdl-source",
    ])
    .nullable(),
  source: graphqlSourceSchema,
});
export const graphqlSpreadSchema = z.strictObject({
  spread_id: prefixedDigestSchema("graphql_spread"),
  definition_id: graphqlDefinitionSchema.shape.definition_id,
  parent_reference_id: graphqlReferenceSchema.shape.reference_id.nullable(),
  name: z.string(),
  target_definition_id: graphqlDefinitionSchema.shape.definition_id.nullable(),
  matching_definitions: z.int().nonnegative(),
  state: z.enum(["resolved", "missing", "ambiguous"]),
  source: graphqlSourceSchema,
});
export const graphqlDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("graphql_diagnostic"),
  code: z.string(),
  message: z.string(),
  source_role: graphqlSourceSchema.shape.role,
  source: graphqlSourceSchema.nullable(),
});
export const graphqlContractSchema = z.strictObject({
  kind: z.literal("graphql-contract"),
  format: z.literal("graphql-sdl"),
  contract_id: prefixedDigestSchema("graphql_contract"),
  decoder_profile: z.literal(GRAPHQL_CONTRACT_PROFILE),
  interpreter: z.strictObject({
    id: z.literal("graphql-js"),
    version: z.string(),
  }),
  artifact: apiContractArtifactSchema,
  operations_artifact: apiContractArtifactSchema.nullable(),
  offset_units: z.literal("utf16-code-units"),
  model_roots: z.strictObject({
    query: z.string().nullable(),
    mutation: z.string().nullable(),
    subscription: z.string().nullable(),
  }),
  types: z.array(graphqlTypeSchema),
  fields: z.array(graphqlFieldSchema),
  definitions: z.array(graphqlDefinitionSchema),
  references: z.array(graphqlReferenceSchema),
  fragment_spreads: z.array(graphqlSpreadSchema),
  diagnostics: z.array(graphqlDiagnosticSchema),
  summary: z.strictObject({
    types: z.int().nonnegative(),
    fields: z.int().nonnegative(),
    definitions: z.int().nonnegative(),
    references: z.int().nonnegative(),
    unknown_references: z.int().nonnegative(),
    model_only_references: z.int().nonnegative(),
    fragment_spreads: z.int().nonnegative(),
    unresolved_spreads: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    status: z.enum(["complete-within-scope", "partial"]),
    schema_declarations: z.enum(["complete", "partial", "unavailable"]),
    schema_model: z.enum(["constructed", "unavailable"]),
    operations: z.enum(["complete", "partial", "unavailable", "not-supplied"]),
    operation_validation: z.literal("field-resolution-only"),
    endpoint_behavior: z.literal("unknown"),
  }),
  limitations: z.array(z.string()),
});
export type GraphqlContract = z.output<typeof graphqlContractSchema>;
export type GraphqlSource = z.output<typeof graphqlSourceSchema>;
export type GraphqlType = z.output<typeof graphqlTypeSchema>;
export type GraphqlField = z.output<typeof graphqlFieldSchema>;
export type GraphqlDefinition = z.output<typeof graphqlDefinitionSchema>;
export type GraphqlReference = z.output<typeof graphqlReferenceSchema>;
export type GraphqlSpread = z.output<typeof graphqlSpreadSchema>;
