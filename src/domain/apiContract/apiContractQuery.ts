import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
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

export const inspectApiContractInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one local OpenAPI JSON document",
  ),
  format: z.literal("openapi-json").default("openapi-json"),
  max_file_bytes: z
    .int()
    .positive()
    .max(API_CONTRACT_MAX_FILE_BYTES)
    .default(API_CONTRACT_MAX_FILE_BYTES)
    .describe(
      "Maximum input document bytes (up to 32 MiB); reply paging does not increase parser allowances",
    ),
  detail: z.enum(["summary", "complete"]).default("summary"),
  view: apiContractViewRequestSchema
    .optional()
    .describe(
      "Return this selected page immediately; complete Evidence is retained and view takes precedence over detail",
    ),
});
export type InspectApiContractInput = z.output<
  typeof inspectApiContractInputSchema
>;
