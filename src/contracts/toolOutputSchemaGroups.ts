import { z } from "zod";

import {
  processCaptureComparisonSchema,
  processCaptureSchema,
} from "../domain/processCapture.js";
import { evidenceBundleSchema } from "../domain/evidenceBundle.js";
import { residualUnknownSchema } from "../domain/residualUnknown.js";
import { referenceKindSchema } from "../domain/hopperValues.js";
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
import { managedApplicationGraphResultSchema } from "../domain/managedApplicationGraph.js";
import { artifactComparisonResultSchema } from "../domain/artifactComparison.js";
import { functionComparisonResultSchema } from "../domain/functionComparison.js";
import { bundleComparisonResultSchema } from "../domain/bundleComparison.js";
import { changedBehaviorResultSchema } from "../domain/changedBehavior.js";
import { callPathResultSchema } from "../domain/callPath.js";
import { staticRuntimeCorrelationResultSchema } from "../domain/staticRuntimeCorrelation.js";
import { reconstructionVerificationResultSchema } from "../domain/reconstructionVerification.js";
import { replayMachineRunOutputSchema } from "../domain/replayMachineRun.js";
import { analysisErrorProjectionSchema } from "./errorSchemas.js";
import {
  addressList,
  addressedEntry,
  bounded,
  containingProcedureResolution,
  functionDossierOutput,
  graphNode,
  lifecycleResultOf,
  nullableText,
  pageOutput,
  procedureIdentity,
  procedureInfoOutput,
  evidenceResultOf as resultOf,
  searchPageOutput,
  segmentOutput,
  sessionProvider,
  providerIdentity,
  toolAvailability,
  symbolDiscoveryOutput,
  targetFormatSchema,
  targetKindSchema,
} from "./toolOutputSchemaPrimitives.js";

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
  project_managed_application_graph: resultOf(
    managedApplicationGraphResultSchema,
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
      z.object({
        view: z.literal("summary"),
        open: z.boolean(),
        provider: providerIdentity,
        active_provider: providerIdentity.nullable(),
        target: z
          .object({
            path: z.string(),
            format: targetFormatSchema,
            kind: targetKindSchema,
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
          })
          .nullable(),
        alignment: z.object({
          state: z.enum(["aligned", "mcp_server_restart_required", "unknown"]),
          reasons: z.array(z.string()),
          remediation: z.string().nullable(),
        }),
        recommended_actions: z.array(z.string()),
      }),
      z.object({
        view: z.literal("capabilities"),
        open: z.boolean(),
        provider: providerIdentity,
        active_provider: providerIdentity.nullable(),
        capability_family: z.string().nullable(),
        capabilities: z.object({
          items: z.array(toolAvailability),
          cursor: z.number().int().min(0),
          limit: z.number().int().min(1),
          total: z.number().int().min(0),
          next_cursor: z.number().int().min(0).nullable(),
          has_more: z.boolean(),
        }),
      }),
      z.union([
        sessionProvider.extend({
          view: z.literal("full"),
          open: z.literal(false),
        }),
        sessionProvider.extend({
          view: z.literal("full"),
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
  run_replay_machine: lifecycleResultOf(replayMachineRunOutputSchema),
};
