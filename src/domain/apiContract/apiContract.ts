import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not OpenAPI format limits. */
export const API_CONTRACT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const API_CONTRACT_FACT_BYTES = 32 * 1024 * 1024;
export const API_CONTRACT_OPERATION = "inspect_api_contract" as const;
export const API_CONTRACT_PROVIDER = {
  id: "rea-api-contract",
  name: "REA offline API contract inventory",
  version: "1",
} as const;

export const apiContractArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});

/** Identity is source-scoped; operation_key separately survives source revisions. */
export const apiContractOperationSchema = z.strictObject({
  operation_id: prefixedDigestSchema("api_operation"),
  operation_key: prefixedDigestSchema("api_operation_key"),
  method: z.string(),
  path: z.string(),
  declared_id: z.string().nullable(),
  source_pointer: z.string(),
  state: z.enum(["declared", "unknown"]),
  reason: z
    .enum(["unresolved-path-item-reference", "malformed-operation"])
    .nullable(),
});
export const apiContractPathReferenceSchema = z.strictObject({
  reference_id: prefixedDigestSchema("api_path_reference"),
  path: z.string(),
  source_pointer: z.string(),
  reference: z.string().nullable(),
  credential_redacted: z.boolean(),
  state: z.enum(["unresolved", "malformed"]),
});
export const apiContractDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("api_contract_diagnostic"),
  source_pointer: z.string(),
  code: z.enum([
    "invalid-info",
    "invalid-paths",
    "invalid-path-key",
    "invalid-path-item",
    "invalid-path-reference",
    "invalid-operation",
    "invalid-operation-id",
    "unknown-path-item-field",
    "invalid-additional-operations",
    "invalid-additional-method",
  ]),
  message: z.string(),
});

export const apiContractSchema = z.strictObject({
  contract_id: prefixedDigestSchema("api_contract"),
  format: z.literal("openapi-json"),
  openapi: z.string(),
  artifact: apiContractArtifactSchema,
  info: z.strictObject({
    title: z.string().nullable(),
    version: z.string().nullable(),
  }),
  operations: z.array(apiContractOperationSchema),
  path_item_references: z.array(apiContractPathReferenceSchema),
  diagnostics: z.array(apiContractDiagnosticSchema),
  summary: z.strictObject({
    operation_slots: z.int().nonnegative(),
    declared: z.int().nonnegative(),
    unknown: z.int().nonnegative(),
    unresolved_path_items: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    scope: z.literal("inline-path-operations"),
    status: z.enum(["complete-within-scope", "partial"]),
    paths_state: z.enum(["object", "absent", "malformed"]),
    path_entries_examined: z.int().nonnegative(),
    reference_resolution: z.literal("not-attempted"),
    schema_validation: z.literal("not-performed"),
    duplicate_json_members: z.literal("last-value-wins"),
  }),
  limitations: z.array(z.string()),
});
export type ApiContract = z.output<typeof apiContractSchema>;
export type ApiContractOperation = z.output<typeof apiContractOperationSchema>;
export type ApiContractDiagnostic = z.output<
  typeof apiContractDiagnosticSchema
>;
export type ApiContractArtifact = z.output<typeof apiContractArtifactSchema>;
