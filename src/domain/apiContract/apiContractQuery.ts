import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { graphqlContractViewRequestSchema } from "./graphqlContractQuery.js";
import {
  API_CONTRACT_MAX_FILE_BYTES,
  apiContractDiagnosticSchema,
  apiContractOperationSchema,
  apiContractPathReferenceSchema,
} from "./apiContract.js";

const page = {
  kind: z.literal("api-contract"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
export const apiContractViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("operations"),
    operation_ids: z
      .array(apiContractOperationSchema.shape.operation_id)
      .optional(),
    operation_keys: z
      .array(apiContractOperationSchema.shape.operation_key)
      .optional(),
    methods: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
    declared_ids: z.array(z.string()).optional(),
    states: z.array(apiContractOperationSchema.shape.state).optional(),
    fields: z.array(apiContractOperationSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("path-item-references"),
    reference_ids: z
      .array(apiContractPathReferenceSchema.shape.reference_id)
      .optional(),
    fields: z.array(apiContractPathReferenceSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("diagnostics"),
    codes: z.array(apiContractDiagnosticSchema.shape.code).optional(),
    fields: z.array(apiContractDiagnosticSchema.keyof()).optional(),
  }),
]);

export const apiContractFormatSchema = z.enum([
  "openapi-json",
  "openapi-yaml",
  "graphql-sdl",
]);
export const apiContractFileBytesSchema = z
  .int()
  .positive()
  .max(API_CONTRACT_MAX_FILE_BYTES)
  .default(API_CONTRACT_MAX_FILE_BYTES)
  .describe(
    "Maximum bytes per input document (up to 32 MiB); reply paging does not increase parser allowances",
  );
export const apiContractViewSelectionSchema = z.discriminatedUnion("kind", [
  apiContractViewRequestSchema,
  graphqlContractViewRequestSchema,
]);
const commonInput = {
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to a local API contract document",
  ),
  max_file_bytes: apiContractFileBytesSchema,
  detail: z.enum(["summary", "complete"]).default("summary"),
};
const selectionDescription =
  "Return this selected page immediately; complete Evidence is retained and view takes precedence over detail";
export const inspectApiContractInputSchema = z
  .union([
    z.strictObject({
      ...commonInput,
      // Both OpenAPI syntaxes share one declaration contract; only the decoder
      // differs, so they form one input group.
      format: z.enum(["openapi-json", "openapi-yaml"]).default("openapi-json"),
      view: apiContractViewRequestSchema
        .optional()
        .describe(selectionDescription),
    }),
    z.strictObject({
      ...commonInput,
      format: z.literal("graphql-sdl"),
      operations_path: absoluteLocalPathStringSchema
        .optional()
        .describe(
          "Optional absolute path to one local GraphQL operation/fragment document; parsed without execution",
        ),
      view: graphqlContractViewRequestSchema
        .optional()
        .describe(selectionDescription),
    }),
  ])
  .meta({ "x-rea-root-discriminator": "format" });
export type InspectApiContractInput = z.output<
  typeof inspectApiContractInputSchema
>;
