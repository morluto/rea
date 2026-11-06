import { z } from "zod";
import {
  graphqlTypeSchema,
  graphqlFieldSchema,
  graphqlDefinitionSchema,
  graphqlReferenceSchema,
  graphqlSpreadSchema,
  graphqlDiagnosticSchema,
} from "./graphqlContract.js";

const page = {
  kind: z.literal("graphql-contract"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
export const graphqlContractViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("types"),
      type_ids: z.array(graphqlTypeSchema.shape.type_id).optional(),
      names: z.array(z.string()).optional(),
      fields: z.array(graphqlTypeSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("fields"),
      field_ids: z.array(graphqlFieldSchema.shape.field_id).optional(),
      field_keys: z.array(z.string()).optional(),
      owner_type_names: z.array(z.string()).optional(),
      fields: z.array(graphqlFieldSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("definitions"),
      definition_ids: z
        .array(graphqlDefinitionSchema.shape.definition_id)
        .optional(),
      names: z.array(z.string()).optional(),
      kinds: z.array(graphqlDefinitionSchema.shape.kind).optional(),
      fields: z.array(graphqlDefinitionSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("references"),
      reference_ids: z
        .array(graphqlReferenceSchema.shape.reference_id)
        .optional(),
      definition_ids: z
        .array(graphqlDefinitionSchema.shape.definition_id)
        .optional(),
      schema_field_ids: z.array(graphqlFieldSchema.shape.field_id).optional(),
      states: z.array(graphqlReferenceSchema.shape.state).optional(),
      fields: z.array(graphqlReferenceSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("fragment-spreads"),
      definition_ids: z
        .array(graphqlDefinitionSchema.shape.definition_id)
        .optional(),
      names: z.array(z.string()).optional(),
      states: z.array(graphqlSpreadSchema.shape.state).optional(),
      fields: z.array(graphqlSpreadSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("diagnostics"),
      codes: z.array(z.string()).optional(),
      fields: z.array(graphqlDiagnosticSchema.keyof()).optional(),
    }),
  ],
);
