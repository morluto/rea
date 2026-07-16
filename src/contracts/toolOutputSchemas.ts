import { z } from "zod";
import {
  processCaptureComparisonSchema,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { evidenceBundleSchema } from "../domain/evidenceBundle.js";
import { residualUnknownSchema } from "../domain/residualUnknown.js";
import {
  functionDossierSchema,
  localVariableSchema,
  procedureClassificationSchema,
  procedureIdentitySchema,
  referenceKindSchema,
} from "../domain/hopperValues.js";
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
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../domain/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../domain/managedMemberComparison.js";
import { managedNativeVerificationResultSchema } from "../domain/managedNativeVerification.js";
import { managedReconstructionImportResultSchema } from "../domain/managedReconstruction.js";
import { managedRuntimeCorrelationResultSchema } from "../domain/managedRuntimeCorrelation.js";
import { artifactComparisonResultSchema } from "../domain/artifactComparison.js";
import { functionComparisonResultSchema } from "../domain/functionComparison.js";
import { bundleComparisonResultSchema } from "../domain/bundleComparison.js";
import { changedBehaviorResultSchema } from "../domain/changedBehavior.js";
import { callPathResultSchema } from "../domain/callPath.js";
import { staticRuntimeCorrelationResultSchema } from "../domain/staticRuntimeCorrelation.js";
import { reconstructionVerificationResultSchema } from "../domain/reconstructionVerification.js";
import { analysisErrorProjectionSchema } from "./errorSchemas.js";
import { analysisProfileSchema } from "../domain/analysisProfile.js";
import {
  PROVIDER_REJECTION_CODES,
  type ProviderRejectionCode,
} from "./providerSelection.js";

/** Compact MCP result with an immutable link to complete session Evidence. */
export const evidenceResultOf = (schema: z.ZodType) =>
  z.strictObject({
    result: schema,
    evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
    evidence_uri: z.string().regex(/^rea:\/\/evidence\/ev_[a-f0-9]{64}$/u),
  });
const resultOf = evidenceResultOf;
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
  "analysis-database",
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
const providerIdentity = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
});
const providerRejectionCode: z.ZodType<ProviderRejectionCode> = z.enum(
  PROVIDER_REJECTION_CODES,
);
const providerDiagnostics = z.record(z.string(), z.json());
const providerAvailability = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    code: z.null(),
    reason: z.null(),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("unavailable"),
    code: providerRejectionCode,
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
]);
const providerTargetSupport = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unknown"),
    code: z.null(),
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("supported"),
    code: z.null(),
    reason: z.null(),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("unsupported"),
    code: z.enum([
      "target_kind_unsupported",
      "target_format_unsupported",
      "architecture_unsupported",
    ]),
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
]);
const sessionProvider = z.object({
  provider: providerIdentity,
  providers: z.array(providerIdentity),
  capabilities: z.array(providerCapability),
  analysis_provider_binding: z
    .object({
      provider: providerIdentity,
      selection_source: z.enum([
        "request",
        "environment",
        "auto-single-candidate",
      ]),
      analysis_profile: analysisProfileSchema,
    })
    .nullable(),
  analysis_provider_candidates: z.array(
    z.object({
      provider: providerIdentity,
      availability: providerAvailability,
      target_support: providerTargetSupport,
      selected: z.boolean(),
      capabilities: z.array(providerCapability),
    }),
  ),
  tool_availability: z.array(
    z.object({
      name: z.string(),
      surface: z.string(),
      available: z.boolean(),
      reason: z.enum([
        "available",
        "target_required",
        "provider_missing",
        "provider_unavailable",
        "target_unsupported",
        "unsupported_host",
        "policy_disabled",
      ]),
      remediation: z.string().nullable(),
      effects: z.strictObject({
        mutatesTarget: z.boolean(),
        mutatesSession: z.boolean(),
        writesFilesystem: z.boolean(),
        launchesProcess: z.boolean(),
        accessesNetwork: z.boolean(),
        changesUiState: z.boolean(),
        mayDiscardData: z.boolean(),
        idempotent: z.boolean(),
      }),
      annotations: z.object({
        read_only: z.boolean(),
        destructive: z.boolean(),
        idempotent: z.boolean(),
        open_world: z.boolean(),
      }),
    }),
  ),
  client_features: z.object({
    elicitation_form: z.boolean(),
    elicitation_url: z.boolean(),
    roots: z.boolean(),
    sampling: z.boolean(),
  }),
  server_identity: z.object({
    package: z.object({
      name: z.string(),
      version: z.string(),
      root_path: z.string(),
      build_commit: z.string().nullable(),
    }),
    server: z.object({
      name: z.string(),
      version: z.string(),
      started_at: z.string(),
      command_path: z.string(),
    }),
    sdk: z.object({
      server: z.string(),
      client_test: z.string(),
      core: z.string(),
    }),
    negotiated_protocol_version: z.string().nullable(),
    client: z.object({ name: z.string(), version: z.string() }).nullable(),
    skill: z.object({ name: z.string(), expected_version: z.string() }),
    catalog: z.record(z.string(), z.json()),
    protocol_features: z.object({
      progress: z.boolean(),
      cancellation: z.boolean(),
      evidence_resources: z.boolean(),
      elicitation: z.boolean(),
    }),
    alignment: z.object({
      state: z.enum(["aligned", "mcp_server_restart_required", "unknown"]),
      reasons: z.array(z.string()),
      remediation: z.string().nullable(),
    }),
  }),
});
const nullableText = z.string().nullable();
const addressList = z.array(z.string());
const addressedEntry = z.object({ address: z.string(), name: z.string() });
const procedureIdentity = procedureIdentitySchema;
const localVariable = localVariableSchema;
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
const availableMemoryPermissions = z.object({
  available: z.literal(true),
  source: z.literal("ghidra-memory-block"),
});
const bounded = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
  });
const addressedValue = z.object({
  address: z.string(),
  value: z.string(),
  value_truncated: z.boolean().optional(),
  symbol: z
    .object({
      primary: z.boolean(),
      dynamic: z.boolean(),
      external: z.boolean(),
      type: z.string(),
      source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
    })
    .optional(),
  procedure: z
    .object({
      external: z.boolean(),
      thunk: z.boolean(),
      thunk_target: z.string().nullable(),
    })
    .optional(),
  string: z
    .object({
      encoding: z.string(),
      termination: z.enum(["missing", "present_or_not_required"]),
      byte_length: z.number().int().min(0),
    })
    .optional(),
});
const pageOutput = z.object({
  items: z.array(addressedValue),
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
  permissions: z.union([unavailable, availableMemoryPermissions]),
  provenance: z.enum(["hopper-public-python-api", "ghidra-memory-block"]),
  address_space: z.string().optional(),
  image_base: z.string().optional(),
  initialized: z.boolean().optional(),
  overlay: z.boolean().optional(),
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
    classification: procedureClassificationSchema.nullable().default(null),
  }),
);
const symbolDiscoveryOutput = (property: "classes" | "protocols") =>
  resultOf(
    z.object({
      count: z.number().int().min(0),
      [property]: z.array(addressedEntry),
    }),
  );
const graphNode = z.discriminatedUnion("status", [
  z.object({
    address: z.string(),
    status: z.literal("ok"),
    calls: z.array(z.string()),
  }),
  z.object({
    address: z.string(),
    status: z.literal("error"),
    error: analysisErrorProjectionSchema,
  }),
]);
const functionDossierOutput = resultOf(functionDossierSchema);

/** Exact structured-content schemas shared by direct analysis providers. */
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
          kind: referenceKindSchema,
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
    z.object({
      items: z.array(
        z.discriminatedUnion("status", [
          z.object({
            address: z.string(),
            status: z.literal("ok"),
            pseudocode: z.string().min(1),
          }),
          z.object({
            address: z.string(),
            status: z.literal("error"),
            error: analysisErrorProjectionSchema,
          }),
        ]),
      ),
      total: z.number().int().min(0),
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
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
    z.discriminatedUnion("status", [
      z.object({
        status: z.literal("resolved"),
        name: z.string(),
        address: z.string(),
        xrefs: addressList,
      }),
      z.object({
        status: z.literal("unresolved"),
        name: z.string(),
        reason: z.literal("name_not_found"),
      }),
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

/** Exact Evidence v2 schema for execution-free managed static analysis. */
export const managedOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inspect_managed_artifact: resultOf(managedArtifactInspectionSchema),
  inspect_managed_members: resultOf(managedMemberInspectionSchema),
  inspect_managed_native_boundaries: resultOf(
    managedNativeBoundaryInspectionSchema,
  ),
};

/** Exact Evidence v2 schema for provider-neutral managed workflows. */
export const managedWorkflowOutputSchemas: Readonly<
  Record<string, z.ZodObject>
> = {
  compare_managed_members: resultOf(managedMemberComparisonResultSchema),
  verify_managed_native_boundaries: resultOf(
    managedNativeVerificationResultSchema,
  ),
  import_managed_reconstruction: resultOf(
    managedReconstructionImportResultSchema,
  ),
  plan_managed_runtime_correlation: resultOf(
    managedRuntimeCorrelationResultSchema,
  ),
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
  close_binary: lifecycleResultOf(
    z.union([
      z.null(),
      z.object({
        path: z.string(),
        bytes: z.number().int().min(0),
        entries: z.number().int().min(0),
      }),
    ]),
  ),
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
  capture_process_scenario: resultOf(processCaptureSchema),
  compare_process_captures: resultOf(processCaptureComparisonSchema),
  compare_artifacts: resultOf(artifactComparisonResultSchema),
  compare_functions: resultOf(functionComparisonResultSchema),
  compare_bundles: resultOf(bundleComparisonResultSchema),
  find_changed_behavior: resultOf(changedBehaviorResultSchema),
  build_call_path: resultOf(callPathResultSchema),
  correlate_static_and_runtime: resultOf(staticRuntimeCorrelationResultSchema),
  verify_reconstruction: resultOf(reconstructionVerificationResultSchema),
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
