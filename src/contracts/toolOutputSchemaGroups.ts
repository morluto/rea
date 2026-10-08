import { z } from "zod";
import { nativeFunctionAnnotationsSchema } from "../domain/native/nativeFunctionAnnotations.js";
import { nativeLoadImageSchema } from "../domain/native/nativeLoadImage.js";
import { nativeUiResultSchema } from "../domain/native/nativeUiObservation.js";
import { nativeValueTraceSchema } from "../domain/native/nativeValueTrace.js";
import { nativeDataTypeSchema } from "../domain/native/nativeDataType.js";
import { nativeCallObservationResultSchema } from "../domain/native/nativeCallObservation.js";
import {
  nativeInstructionSchema,
  nativeCallTargetsSchema,
} from "../domain/native/nativeInstruction.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { residualUnknownSchema } from "../domain/residualUnknown.js";
import { evidenceBundleSchema } from "../domain/evidenceBundle.js";

import {
  processCaptureComparisonSchema,
  processCaptureSchema,
} from "../domain/process/processCapture.js";
import {
  analysisBookmarkSchema,
  functionInstructionWindowSchema,
  referenceEdgeSchema,
  unresolvedCallSchema,
  analysisStringSchema,
} from "../domain/hopperValues.js";
import { nativeApiInspectionResultSchema } from "../domain/native/nativeApiBoundary.js";
import {
  demangleSwiftSchema,
  inspectMachoSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  listArchitecturesSchema,
} from "../domain/native/nativeInspection.js";
import { artifactExtractionResultSchema } from "../domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import { interfaceBuilderAnalysisSchema } from "../domain/apple/interfaceBuilderGraph.js";
import { dylibResolutionResultSchema } from "../domain/apple/dylibResolution.js";
import { keyedArchiveResultSchema } from "../domain/apple/keyedArchive.js";
import { appleAssetCatalogResultSchema } from "../domain/apple/appleAssetCatalog.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../domain/managed/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../domain/managed/managedMemberComparison.js";
import { managedNativeVerificationResultSchema } from "../domain/managed/managedNativeVerification.js";
import { managedReconstructionImportResultSchema } from "../domain/managed/managedReconstruction.js";
import { managedApplicationGraphResultSchema } from "../domain/managed/managedApplicationGraph.js";
import { artifactComparisonResultSchema } from "../domain/artifactComparison.js";
import { functionComparisonResultSchema } from "../domain/functionComparison.js";
import { bundleComparisonResultSchema } from "../domain/bundleComparison.js";
import { changedBehaviorResultSchema } from "../domain/changedBehavior.js";
import { callPathResultSchema } from "../domain/callPath.js";
import { staticRuntimeCorrelationResultSchema } from "../domain/staticRuntimeCorrelation.js";
import { reconstructionVerificationResultSchema } from "../domain/reconstructionVerification.js";
import { analysisErrorProjectionSchema } from "./errorSchemas.js";
import { nativeDispatchMetadataResultSchema } from "../domain/native/objcSwiftMetadata.js";
import { nativeInvestigationTraceSchema } from "../domain/native/nativeInvestigationGraph.js";
import {
  addressList,
  addressedValue,
  addressedEntry,
  containingProcedureResolution,
  functionDossierOutput,
  graphNode,
  lifecycleResultOf,
  nullableText,
  procedureIdentity,
  procedureInfoOutput,
  evidenceResultOf as resultOf,
  segmentOutput,
  sessionProvider,
  symbolDiscoveryOutput,
  targetFormatSchema,
  targetKindSchema,
} from "./toolOutputSchemaPrimitives.js";

const contextFacetSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), value: jsonValueSchema }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.string(),
    remediation: z.string(),
  }),
]);
const bookmarkFacetSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    value: z.array(analysisBookmarkSchema),
  }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.string(),
    remediation: z.string(),
  }),
]);

/** Exact structured-content schemas shared by direct analysis providers. */
export const officialOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  annotate_native_function: resultOf(nativeFunctionAnnotationsSchema),
  inspect_native_load_image: resultOf(nativeLoadImageSchema),
  inspect_native_data_type: resultOf(nativeDataTypeSchema),
  inspect_native_instruction: resultOf(nativeInstructionSchema),
  resolve_native_call_targets: resultOf(nativeCallTargetsSchema),
  address_name: resultOf(nullableText),
  comment: resultOf(nullableText),
  current_address: resultOf(z.string()),
  current_procedure: resultOf(z.string()),
  current_document: resultOf(z.string()),
  goto_address: resultOf(z.string()),
  inline_comment: resultOf(nullableText),
  list_bookmarks: resultOf(z.array(analysisBookmarkSchema)),
  list_documents: resultOf(z.array(z.string())),
  list_names: resultOf(z.array(addressedValue)),
  list_procedures: resultOf(z.array(addressedValue)),
  list_segments: segmentOutput,
  list_strings: resultOf(z.array(analysisStringSchema)),
  next_address: resultOf(z.string()),
  prev_address: resultOf(z.string()),
  procedure_address: resultOf(z.string()),
  procedure_assembly: resultOf(z.string()),
  procedure_callees: resultOf(addressList),
  procedure_callers: resultOf(addressList),
  procedure_info: procedureInfoOutput,
  read_function_instructions: resultOf(functionInstructionWindowSchema),
  read_bytes: resultOf(
    z.object({
      address: z.string(),
      requested_bytes: z.number().int().min(1),
      returned_bytes: z.number().int().min(0),
      bytes_hex: z.string().regex(/^(?:[a-f0-9]{2})*$/u),
      complete: z.boolean(),
    }),
  ),
  address_to_file_offset: resultOf(
    z.object({
      address: z.string(),
      file_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      provider_file_offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .exactOptional()
        .describe(
          "Original coordinate returned by the provider's mapping API.",
        ),
      image_base_file_offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .exactOptional()
        .describe(
          "File offset of the loaded image within its source container; zero for a thin executable.",
        ),
      source_path: z
        .string()
        .exactOptional()
        .describe(
          "Observed original executable path used to verify the file mapping.",
        ),
    }),
  ),
  procedure_references: resultOf(
    z.object({
      procedure: procedureIdentity,
      direction: z.enum(["incoming", "outgoing"]),
      reference_kinds_available: z.boolean().optional(),
      unresolved_calls: z.array(unresolvedCallSchema).default([]),
      references: z.array(referenceEdgeSchema),
    }),
  ),
  procedure_pseudo_code: resultOf(nullableText),
  resolve_containing_procedure: resultOf(containingProcedureResolution),
  search_procedures: resultOf(
    z.array(z.object({ address: z.string(), value: z.string() })),
  ),
  search_strings: resultOf(z.array(analysisStringSchema)),
  set_address_name: resultOf(z.boolean()),
  set_addresses_names: resultOf(z.record(z.string(), z.boolean())),
  set_bookmark: resultOf(z.boolean()),
  set_comment: resultOf(z.boolean()),
  set_inline_comment: resultOf(z.boolean()),
  unset_bookmark: resultOf(z.boolean()),
  xrefs: resultOf(addressList),
};

const literalTraceOutput = resultOf(
  z.object({
    query: z.string(),
    search_mode: z.literal("literal"),
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
);

const callPathTraceOutput = resultOf(
  z.object({
    start: z.string(),
    goal: z.string().nullable(),
    direction: z.enum(["forward", "backward"]),
    goal_status: z.enum(["not_requested", "reached", "not_reached"]),
    nodes: z.array(
      z.object({
        address: z.string(),
        depth: z.number().int().min(0),
      }),
    ),
    edges: z.array(
      z.object({
        source_address: z.string(),
        target_address: z.string(),
        discovery_depth: z.number().int().min(1),
      }),
    ),
    traversal_path: z.array(z.string()),
    failures: z.array(
      z.object({
        address: z.string(),
        error: analysisErrorProjectionSchema,
      }),
    ),
    traversal: z.object({
      nodes_visited: z.number().int().min(1),
    }),
    truncated: z.boolean(),
    residual_unknowns: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
);

/** Exact structured-content schemas for composed analysis workflows. */
export const enhancedOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inspect_native_dispatch_metadata: resultOf(
    nativeDispatchMetadataResultSchema,
  ),
  trace_native_values: resultOf(nativeValueTraceSchema),
  trace_native_ui_action: resultOf(nativeInvestigationTraceSchema),
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
      segments: z.array(
        z.object({
          name: z.string(),
          start: z.string(),
          end: z.string(),
          length: z.number().min(0),
        }),
      ),
      segment_count: z.number().int().min(0),
      procedure_count: z.number().int().min(0),
      string_count: z.number().int().min(0),
    }),
  ),
  analyze_function: functionDossierOutput,
  inspect_native_api: resultOf(nativeApiInspectionResultSchema),
  trace_feature: literalTraceOutput,
  trace_call_path: callPathTraceOutput,
};

/** Exact Evidence schemas for provider-neutral native inspection. */
export const nativeOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  observe_native_ui: resultOf(nativeUiResultSchema),
  capture_native_ui_scenario: resultOf(nativeUiResultSchema),
  observe_native_calls: resultOf(nativeCallObservationResultSchema),
  inspect_macho: resultOf(inspectMachoSchema),
  inspect_signature: resultOf(inspectSignatureSchema),
  inspect_plist: resultOf(inspectPlistSchema),
  list_architectures: resultOf(listArchitecturesSchema),
  demangle_swift: resultOf(demangleSwiftSchema),
};

/** Exact Evidence schemas for provider-neutral artifact graph operations. */
export const artifactOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inspect_artifact: resultOf(artifactInspectionResultSchema),
  extract_artifact: resultOf(artifactExtractionResultSchema),
  decode_interface_builder: resultOf(interfaceBuilderAnalysisSchema),
  inspect_keyed_archive: resultOf(keyedArchiveResultSchema),
  inspect_asset_catalog: resultOf(appleAssetCatalogResultSchema),
  trace_dylib_resolution: resultOf(dylibResolutionResultSchema),
};

/** Exact Evidence schema for execution-free managed static analysis. */
export const managedOutputSchemas: Readonly<Record<string, z.ZodObject>> = {
  inspect_managed_artifact: resultOf(managedArtifactInspectionSchema),
  inspect_managed_members: resultOf(managedMemberInspectionSchema),
  inspect_managed_native_boundaries: resultOf(
    managedNativeBoundaryInspectionSchema,
  ),
};

/** Exact Evidence schema for provider-neutral managed workflows. */
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
  project_managed_application_graph: resultOf(
    managedApplicationGraphResultSchema,
  ),
};

/** Exact structured-content schemas for target lifecycle operations. */
export const sessionOutputSchemas = {
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
      z.union([
        sessionProvider.extend({
          open: z.literal(false),
        }),
        sessionProvider.extend({
          open: z.literal(true),
          path: z.string(),
          format: targetFormatSchema,
          kind: targetKindSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
        }),
      ]),
    ]),
  ),
  export_evidence_bundle: lifecycleResultOf(
    z.object({
      path: z.string(),
      bytes: z.number().int().min(0),
      records: z.number().int().min(0),
      unknowns: z.number().int().min(0),
    }),
  ),
  get_evidence_bundle: lifecycleResultOf(evidenceBundleSchema),
  get_navigation_context: lifecycleResultOf(
    z.object({
      document: z.string(),
      address: z.string(),
      procedure: z.union([z.string(), z.null()]),
    }),
  ),
  inspect_address_context: lifecycleResultOf(
    z.object({
      address: z.string(),
      document: z.string().nullable(),
      name: contextFacetSchema,
      procedure: contextFacetSchema,
      comment: contextFacetSchema,
      inline_comment: contextFacetSchema,
      bookmarks: bookmarkFacetSchema,
    }),
  ),
  import_evidence_bundle: lifecycleResultOf(
    z.object({
      imported: z.number().int().min(0),
      unknowns_added: z.number().int().min(0),
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
  list_unknowns: lifecycleResultOf(
    z.object({
      items: z.array(residualUnknownSchema),
      total: z.number().int().min(0),
    }),
  ),
  record_unknown: lifecycleResultOf(residualUnknownSchema),
  update_unknown: lifecycleResultOf(residualUnknownSchema),
  verify_unknown_resolution: lifecycleResultOf(
    z.object({
      valid: z.boolean(),
      truthVerified: z.boolean(),
      unknown: residualUnknownSchema,
    }),
  ),
} satisfies Readonly<Record<string, z.ZodObject>>;
