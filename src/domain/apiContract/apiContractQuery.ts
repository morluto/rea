import { analysisViewPageFields } from "../analysisView/analysisViewPageFields.js";
import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimit,
  type ParameterBudget,
} from "../parameterBudget.js";
import { graphqlContractViewRequestSchema } from "./graphqlContractQuery.js";
import {
  API_CONTRACT_MAX_FILE_BYTES,
  apiContractDiagnosticSchema,
  apiContractOperationSchema,
  apiContractPathReferenceSchema,
} from "./apiContract.js";
import { presentRootDiscriminator } from "../schemaAnnotations.js";

const page = analysisViewPageFields("api-contract");
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

/** Per-call document byte budget shared by the input schema and refusal limit. */
export const API_CONTRACT_FILE_BYTES_BUDGET: ParameterBudget = {
  minimum: 1,
  maximum: API_CONTRACT_MAX_FILE_BYTES,
  default_value: API_CONTRACT_MAX_FILE_BYTES,
  unit: "bytes",
};

/** Build a structured per-call refusal limit using the input schema's own bounds. */
export const apiContractFileBytesLimit = (
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  ...parameterBudgetLimit(
    "max_file_bytes",
    API_CONTRACT_FILE_BYTES_BUDGET,
    effectiveValue,
  ),
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});

const apiContractFileBytesSchema = z
  .int()
  // Keep exclusiveMinimum: 0 so advertised JSON Schema output stays unchanged.
  .positive()
  .max(API_CONTRACT_FILE_BYTES_BUDGET.maximum)
  .default(API_CONTRACT_FILE_BYTES_BUDGET.default_value)
  .describe(
    "Maximum bytes per input document (up to 32 MiB); reply paging does not increase parser allowances",
  );
const commonInput = {
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to a local API contract document",
  ),
  max_file_bytes: apiContractFileBytesSchema,
  detail: z.enum(["summary", "complete"]).default("summary"),
};
const selectionDescription =
  "Return this selected page immediately; complete Evidence is retained and view takes precedence over detail";
export const inspectApiContractInputSchema = presentRootDiscriminator(
  z.union([
    z.strictObject({
      ...commonInput,
      format: z.literal("openapi-json").default("openapi-json"),
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
  ]),
  "format",
);
export type InspectApiContractInput = z.output<
  typeof inspectApiContractInputSchema
>;
