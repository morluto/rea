import { z } from "zod";
import { evidenceSchema } from "../domain/evidence.js";
import {
  processCaptureComparisonSchema,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { evidenceBundleSchema } from "../domain/evidenceBundle.js";
import { residualUnknownSchema } from "../domain/residualUnknown.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import {
  demangleSwiftSchema,
  inspectMachoSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  listArchitecturesSchema,
} from "../domain/nativeInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../domain/artifactGraph.js";
import { artifactComparisonResultSchema } from "../domain/artifactComparison.js";
import { functionComparisonResultSchema } from "../domain/functionComparison.js";
import { bundleComparisonResultSchema } from "../domain/bundleComparison.js";
import { changedBehaviorResultSchema } from "../domain/changedBehavior.js";
import { callPathResultSchema } from "../domain/callPath.js";
import { staticRuntimeCorrelationResultSchema } from "../domain/staticRuntimeCorrelation.js";
import { reconstructionVerificationResultSchema } from "../domain/reconstructionVerification.js";

const resultOf = (schema: z.ZodType) =>
  evidenceSchema
    .omit({ normalized_result: true })
    .extend({ normalized_result: schema });
const lifecycleResultOf = (schema: z.ZodType) => z.object({ result: schema });

/** Resolve a required named output schema or reject contract drift. */
export const requireOutputSchema = (
  schemas: Readonly<Record<string, z.ZodObject>>,
  name: string,
): z.ZodObject => {
  const schema = schemas[name];
  if (schema === undefined)
    throw new Error(`Missing output schema for ${name}`);
  return schema;
};
const targetFormatSchema = z.enum([
  "hopper",
  "mach-o",
  "elf",
  "pe",
  "zip",
  "ipa",
  "apk",
  "asar",
  "dmg",
  "pkg",
  "plist",
  "javascript",
  "source-map",
]);
const targetKindSchema = z.enum([
  "executable",
  "database",
  "archive",
  "artifact",
]);
const providerCapability = z.object({
  operation: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
  input_contract_version: z.number().int().min(1),
  output_contract_version: z.number().int().min(1),
  pagination: z.enum(["none", "offset", "cursor"]),
  exhaustive: z.boolean(),
  effects: z.object({
    mutates_artifact: z.boolean(),
    launches_process: z.boolean(),
    may_show_ui: z.boolean(),
    may_access_network: z.boolean(),
    may_write_filesystem: z.boolean(),
    changes_permissions: z.boolean(),
    requires_root: z.boolean(),
  }),
  limits: z.object({
    max_results: z.number().int().min(0).nullable(),
    max_payload_bytes: z.number().int().min(0).nullable(),
    timeout_ms: z.number().int().min(0).nullable(),
  }),
  limitations: z.array(z.string()),
});
const sessionProvider = z.object({
  provider: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string().nullable(),
  }),
  capabilities: z.array(providerCapability),
});
const nullableText = z.string().nullable();
const addressList = z.array(z.string());
const addressedEntry = z.object({ address: z.string(), name: z.string() });
const procedureIdentity = z.object({ address: z.string(), name: z.string() });
const localVariable = z.object({
  description: z.string(),
  provenance: z.literal("hopper-public-python-api"),
});
const containingProcedureResolution = z.discriminatedUnion("found", [
  z.object({
    query_address: z.string(),
    found: z.literal(true),
    procedure: procedureIdentity,
  }),
  z.object({
    query_address: z.string(),
    found: z.literal(false),
    procedure: z.null(),
    reason: z.enum(["outside_segments", "not_in_procedure"]),
  }),
]);
const unavailable = z.object({
  available: z.literal(false),
  reason: z.string(),
});
const bounded = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
  });
const pageOutput = z.object({
  items: z.array(z.object({ address: z.string(), value: z.string() })),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  next_offset: z.number().int().min(0).nullable(),
  has_more: z.boolean(),
});
const searchPageOutput = pageOutput.extend({
  items: z.array(
    z.object({
      address: z.string(),
      value: z.string(),
      value_truncated: z.boolean(),
    }),
  ),
});
const memoryRegionOutput = z.object({
  name: z.string(),
  start: z.string(),
  end: z.string(),
  readable: z.boolean().nullable(),
  writable: z.boolean().nullable(),
  executable: z.boolean().nullable(),
  permissions: unavailable,
  provenance: z.literal("hopper-public-python-api"),
});
const segmentOutput = resultOf(
  z.array(memoryRegionOutput.extend({ sections: z.array(memoryRegionOutput) })),
);
const procedureInfoOutput = resultOf(
  z.object({
    name: z.string(),
    entrypoint: z.string(),
    basicblock_count: z.number().int().min(0),
    length: z.number().min(0),
    signature: nullableText,
    locals: z.array(localVariable),
  }),
);
const symbolDiscoveryOutput = (property: "classes" | "protocols") =>
  resultOf(
    z.object({
      count: z.number().int().min(0),
      [property]: z.array(addressedEntry),
    }),
  );
const graphNode = z.union([
  z.object({ address: z.string(), calls: z.array(z.string()) }),
  z.object({ address: z.string(), error: z.string() }),
]);
const functionDossierOutput = resultOf(functionDossierSchema);

/** Exact structured-content schemas for the direct Hopper operations. */
export const officialOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  address_name: resultOf(nullableText),
  comment: resultOf(nullableText),
  current_address: resultOf(z.string()),
  current_procedure: resultOf(z.string()),
  current_document: resultOf(z.string()),
  goto_address: resultOf(z.string()),
  inline_comment: resultOf(nullableText),
  list_bookmarks: resultOf(z.array(addressedEntry)),
  list_documents: resultOf(z.array(z.string())),
  list_names: resultOf(pageOutput),
  list_procedures: resultOf(pageOutput),
  list_segments: segmentOutput,
  list_strings: resultOf(pageOutput),
  next_address: resultOf(z.string()),
  prev_address: resultOf(z.string()),
  procedure_address: resultOf(z.string()),
  procedure_assembly: resultOf(z.string()),
  procedure_callees: resultOf(addressList),
  procedure_callers: resultOf(addressList),
  procedure_info: procedureInfoOutput,
  procedure_references: resultOf(
    z.object({
      procedure: procedureIdentity,
      direction: z.enum(["incoming", "outgoing"]),
      references: bounded(
        z.object({
          source_address: z.string(),
          target_address: z.string(),
          source_procedure: procedureIdentity.nullable(),
          target_procedure: procedureIdentity.nullable(),
          kind: unavailable,
        }),
      ),
      instructions_scanned: z.number().int().min(0),
      instruction_scan_truncated: z.boolean(),
    }),
  ),
  procedure_pseudo_code: resultOf(nullableText),
  resolve_containing_procedure: resultOf(containingProcedureResolution),
  search_procedures: resultOf(searchPageOutput),
  search_strings: resultOf(searchPageOutput),
  set_address_name: resultOf(z.boolean()),
  set_addresses_names: resultOf(z.record(z.string(), z.boolean())),
  set_bookmark: resultOf(z.boolean()),
  set_comment: resultOf(z.boolean()),
  set_current_document: resultOf(z.string()),
  set_inline_comment: resultOf(z.boolean()),
  unset_bookmark: resultOf(z.boolean()),
  xrefs: resultOf(addressList),
};

/** Exact structured-content schemas for composed analysis workflows. */
export const enhancedOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  swift_classes: symbolDiscoveryOutput("classes"),
  get_objc_classes: symbolDiscoveryOutput("classes"),
  get_objc_protocols: symbolDiscoveryOutput("protocols"),
  batch_decompile: resultOf(
    z.union([
      z.object({ error: z.literal("No addresses provided") }),
      z.record(z.string(), z.string()),
    ]),
  ),
  get_call_graph: resultOf(z.record(z.string(), z.array(graphNode))),
  analyze_swift_types: resultOf(
    z.object({
      total: z.number().int().min(0),
      categories: z.record(
        z.string(),
        z.object({
          count: z.number().int().min(0),
          items: z.array(addressedEntry),
        }),
      ),
    }),
  ),
  find_xrefs_to_name: resultOf(
    z.union([
      z.object({ xrefs: addressList }),
      z.object({ error: z.string() }),
    ]),
  ),
  binary_overview: resultOf(
    z.object({
      document: z.string(),
      detail: z.enum(["concise", "detailed"]),
      segments: z.array(
        z.object({
          name: z.string(),
          start: z.string(),
          end: z.string(),
          length: z.number().min(0).optional(),
        }),
      ),
      segment_count: z.number().int().min(0),
      procedure_count: z.number().int().min(0),
      string_count: z.number().int().min(0),
    }),
  ),
  analyze_function: functionDossierOutput,
  trace_feature: resultOf(
    z.object({
      query: z.string(),
      search_mode: z.literal("literal"),
      operations_used: z.number().int().min(0),
      operation_budget: z.number().int().min(1),
      matches: z.array(
        z.object({
          type: z.enum(["string", "procedure"]),
          address: z.string(),
          value: z.string(),
        }),
      ),
      references: z.array(
        z.object({
          target_address: z.string(),
          source_address: z.string(),
          containing_procedure: containingProcedureResolution,
        }),
      ),
      truncated: z.boolean(),
      residual_unknowns: z.array(z.string()),
    }),
  ),
};

/** Exact Evidence v2 schemas for provider-neutral native inspection. */
export const nativeOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inspect_macho: resultOf(inspectMachoSchema),
  inspect_signature: resultOf(inspectSignatureSchema),
  inspect_plist: resultOf(inspectPlistSchema),
  list_architectures: resultOf(listArchitecturesSchema),
  demangle_swift: resultOf(demangleSwiftSchema),
};

/** Exact Evidence v2 schemas for provider-neutral artifact graph operations. */
export const artifactOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inventory_artifact: resultOf(artifactInventoryResultSchema),
  extract_artifact: resultOf(artifactExtractionResultSchema),
};

/** Exact structured-content schemas for target lifecycle operations. */
export const sessionOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  open_binary: lifecycleResultOf(
    z.object({
      path: z.string(),
      format: targetFormatSchema,
      kind: targetKindSchema,
      loaderArgs: z.array(z.string()),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
    }),
  ),
  close_binary: lifecycleResultOf(z.null()),
  binary_session: lifecycleResultOf(
    z.union([
      sessionProvider.extend({ open: z.literal(false) }),
      sessionProvider.extend({
        open: z.literal(true),
        path: z.string(),
        format: targetFormatSchema,
        kind: targetKindSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
      }),
    ]),
  ),
  export_evidence_bundle: lifecycleResultOf(
    z.union([
      evidenceBundleSchema,
      z.object({
        path: z.string(),
        bytes: z.number().int().min(0),
        records: z.number().int().min(0),
      }),
    ]),
  ),
  import_evidence_bundle: lifecycleResultOf(
    z.object({
      imported: z.number().int().min(0),
      total: z.number().int().min(0),
    }),
  ),
  capture_process_scenario: lifecycleResultOf(
    evidenceSchema
      .omit({ normalized_result: true })
      .extend({ normalized_result: processCaptureSchema }),
  ),
  compare_process_captures: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: processCaptureComparisonSchema,
    }),
  ),
  compare_artifacts: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: artifactComparisonResultSchema,
    }),
  ),
  compare_functions: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: functionComparisonResultSchema,
    }),
  ),
  compare_bundles: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: bundleComparisonResultSchema,
    }),
  ),
  find_changed_behavior: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: changedBehaviorResultSchema,
    }),
  ),
  build_call_path: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: callPathResultSchema,
    }),
  ),
  correlate_static_and_runtime: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: staticRuntimeCorrelationResultSchema,
    }),
  ),
  verify_reconstruction: lifecycleResultOf(
    evidenceSchema.omit({ normalized_result: true }).extend({
      normalized_result: reconstructionVerificationResultSchema,
    }),
  ),
  list_unknowns: lifecycleResultOf(z.array(residualUnknownSchema)),
  record_unknown: lifecycleResultOf(residualUnknownSchema),
  update_unknown: lifecycleResultOf(residualUnknownSchema),
  verify_unknown_resolution: lifecycleResultOf(
    z.object({
      valid: z.boolean(),
      truthVerified: z.boolean(),
      unknown: residualUnknownSchema,
    }),
  ),
};
