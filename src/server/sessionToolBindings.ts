import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  executeSessionFunctionAnalysis,
  executeSessionWorkflowEvidence,
  type WorkflowSession,
} from "../application/SessionWorkflowEvidence.js";
import { projectManagedApplicationGraphExecution } from "../application/managed/ManagedApplicationGraphService.js";
import { compareManagedMembersExecution } from "../application/managed/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesExecution } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionExecution } from "../application/managed/ManagedReconstructionService.js";
import { compareFunctionEvidence } from "../application/investigation/FunctionComparisonEvidence.js";
import { compareProcessEvidence } from "../application/process/ProcessComparisonService.js";
import {
  buildCallPathEvidence,
  correlateStaticAndRuntimeEvidence,
  findChangedBehaviorEvidence,
  verifyReconstructionEvidence,
  type InvestigationWorkflowExecution,
} from "../application/investigation/InvestigationWorkflows.js";
import {
  artifactComparisonExecution,
  resolveArtifactComparisonSources,
} from "../application/artifacts/ArtifactComparisonEvidence.js";
import {
  inventoryArtifactPath,
  retainedInArtifactScope,
  type ArtifactPathInspectionDependencies,
} from "../application/artifacts/ArtifactPathInspection.js";
import {
  bundleComparisonExecution,
  readBundleComparisonSources,
} from "../application/investigation/BundleComparisonEvidence.js";
import {
  compareApplicationVersionsExecution,
  compareJavaScriptExportShapesExecution,
  inspectionExecution,
  reconstructionObligationLedgerExecution,
  settledExecution,
  sourceToBundleComparisonExecution,
} from "../application/ApplicationToolExecutions.js";
import {
  projectAndroidApplicationEvidence,
  projectAppleApplicationEvidence,
  projectHarmonyApplicationEvidence,
} from "../application/InventoryProjectionEvidence.js";
import { inspectApiContractEvidence } from "../application/apiContract/ApiContractService.js";
import type { EvidenceWorkflowExecution } from "../application/investigation/EvidenceWorkflowExecution.js";
import { traceApplicationFeatureEvidence } from "../application/javascript/JavaScriptApplicationWorkflowService.js";
import { traceJavaScriptSemanticsEvidence } from "../application/javascript/JavaScriptSemanticTraceService.js";
import { compareStaticAndObservedEndpointsEvidence } from "../application/javascript/StaticObservedEndpointComparisonService.js";
import { inspectNtfsJournalEvidence } from "../application/ntfs/NtfsJournalService.js";
import { evaluateReconstructionCoverage } from "../application/ReconstructionCoverageService.js";
import { exportEnvironmentBundleTool } from "../application/environment/environmentBundleTool.js";
import { PlaywrightTraceService } from "../application/playwrightTrace/PlaywrightTraceService.js";
import { PlaywrightTraceDecoder } from "../browser/history/playwrightTrace/PlaywrightTraceDecoder.js";
import {
  evidenceBundleExportReceipt,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { inspectEvidenceBundle } from "../application/investigation/InspectEvidenceBundle.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { ResidualUnknown } from "../domain/residualUnknown.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import { CommittedValue } from "./contractToolHandler.js";
import type { ContractToolBindings } from "./contractToolBindings.js";

/**
 * The session that admits and records derived Evidence, and the artifact
 * resource scope its comparisons of caller-named files read under.
 */
export interface SessionDerivedToolOptions {
  readonly session: BinarySessionPort;
  readonly resources: ArtifactResourceScope;
  /** Inventories a comparison's path sources; absent, they are refused. */
  readonly createArtifactPathInspection?:
    | (() => Promise<ArtifactPathInspectionDependencies>)
    | undefined;
}

/** The artifact resource scope application workflows read caller-named files under. */
export interface ApplicationWorkflowToolOptions {
  readonly resources: ArtifactResourceScope;
}

/**
 * A committed residual unknown, with the receipt naming its revision and
 * mutation Evidence for a response too large to deliver.
 */
const committedUnknown = (
  result: Result<ResidualUnknown, AnalysisError>,
): Result<CommittedValue, AnalysisError> =>
  result.ok
    ? ok(
        new CommittedValue(result.value, {
          committed_unknown: {
            unknown_id: result.value.unknown_id,
            revision: result.value.revision,
            mutation_evidence_ids: result.value.mutation_evidence_ids,
          },
          evidence_reference: {
            kind: "retained-evidence",
            evidence_id: result.value.mutation_evidence_ids[0]!,
          },
        }),
      )
    : result;

/** A requested view, or the summary view a `detail: "summary"` request selects. */
const requestedView = (input: {
  readonly detail?: "complete" | "summary";
  readonly view?: AnalysisViewRequest | undefined;
}): AnalysisViewRequest | undefined =>
  input.view ?? (input.detail === "summary" ? { kind: "summary" } : undefined);

const exportEnvironmentBundleContract = toolContract(
  "export_environment_bundle",
);

/** A completed workflow that leaves no residual unknown. */
const settledResult = (
  result: Result<EvidenceWorkflowExecution, AnalysisError>,
): Result<InvestigationWorkflowExecution, AnalysisError> =>
  result.ok ? ok(settledExecution(result.value)) : result;

export const bindSessionDerivedTools = ({
  session,
  resources,
  createArtifactPathInspection,
}: SessionDerivedToolOptions): ContractToolBindings => ({
  compare_functions: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      compareFunctionEvidence(input, evidenceForAnalysis, signal),
  },
  compare_process_captures: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      compareProcessEvidence(input, evidenceForAnalysis, { signal }),
  },
  // Investigation workflows validate their own raw request.
  find_changed_behavior: {
    admission: "application",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      findChangedBehaviorEvidence(input, { evidenceForAnalysis }, signal),
  },
  build_call_path: {
    admission: "application",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      buildCallPathEvidence(input, { evidenceForAnalysis }, signal),
  },
  correlate_static_and_runtime: {
    admission: "application",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      correlateStaticAndRuntimeEvidence(input, { evidenceForAnalysis }, signal),
  },
  // Verification reads the session's immutable bundle as a whole.
  verify_reconstruction: {
    admission: "sdk",
    session,
    derive: (input) => verifyReconstructionEvidence(input, session),
  },
  // Comparisons of caller-named files read them under the server's
  // artifact resource scope before deriving.
  compare_artifacts: {
    admission: "application",
    session,
    resources,
    acquire: async (input, { evidenceForAnalysis, signal, resources }) => {
      const sources = await resolveArtifactComparisonSources(
        input,
        evidenceForAnalysis,
        {
          signal,
          resources,
          ...(createArtifactPathInspection === undefined
            ? {}
            : {
                inventoryPath: async (source, sourceSignal) =>
                  inventoryArtifactPath(
                    await createArtifactPathInspection(),
                    source,
                    sourceSignal,
                    retainedInArtifactScope(resources),
                  ),
              }),
        },
      );
      return sources.ok
        ? ok(() => artifactComparisonExecution(sources.value))
        : sources;
    },
  },
  compare_bundles: {
    admission: "sdk",
    session,
    resources,
    acquire: async (input, { signal, resources }) => {
      const sources = await readBundleComparisonSources(input, {
        signal,
        resources,
      });
      return sources.ok
        ? ok(() => bundleComparisonExecution(sources.value))
        : sources;
    },
  },
});

export const bindManagedWorkflowTools = (
  session: BinarySessionPort,
): ContractToolBindings => ({
  compare_managed_members: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      compareManagedMembersExecution(input, evidenceForAnalysis, { signal }),
  },
  verify_managed_native_boundaries: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      verifyManagedNativeBoundariesExecution(input, evidenceForAnalysis, {
        signal,
      }),
  },
  import_managed_reconstruction: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      importManagedReconstructionExecution(input, evidenceForAnalysis, {
        signal,
      }),
  },
  project_managed_application_graph: {
    admission: "sdk",
    session,
    derive: (input, evidenceForAnalysis, signal) =>
      projectManagedApplicationGraphExecution(input, evidenceForAnalysis, {
        signal,
      }),
  },
});

export const bindApplicationWorkflowTools = (
  { resources }: ApplicationWorkflowToolOptions,
  { evidenceById }: AnalysisViewRetention,
): ContractToolBindings => {
  const playwright = new PlaywrightTraceService(
    new PlaywrightTraceDecoder(resources),
  );
  return {
    trace_application_feature: {
      admission: "sdk",
      view: ({ view }) => view,
      workflow: async ({ view: _selected, ...input }, { signal }) =>
        settledResult(
          traceApplicationFeatureEvidence(input, evidenceById, { signal }),
        ),
    },
    trace_javascript_semantics: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        settledResult(
          traceJavaScriptSemanticsEvidence(input, evidenceById, { signal }),
        ),
    },
    compare_application_versions: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        compareApplicationVersionsExecution(input, evidenceById, { signal }),
    },
    compare_static_and_observed_endpoints: {
      admission: "sdk",
      view: requestedView,
      workflow: async (input, { signal }) =>
        settledResult(
          await compareStaticAndObservedEndpointsEvidence(input, evidenceById, {
            signal,
          }),
        ),
    },
    inspect_api_contract: {
      admission: "sdk",
      view: requestedView,
      workflow: async (input, { signal }) =>
        inspectionExecution(
          await inspectApiContractEvidence(input, resources, { signal }),
        ),
    },
    inspect_ntfs_journal: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        inspectionExecution(
          await inspectNtfsJournalEvidence(input, resources, signal),
        ),
    },
    inspect_playwright_trace: {
      admission: "sdk",
      view: requestedView,
      workflow: async (input, { signal }) =>
        inspectionExecution(await playwright.inspect(input, signal)),
    },
    compare_source_to_bundle: {
      admission: "sdk",
      view: ({ view }) => view,
      workflow: (input, { signal }) =>
        sourceToBundleComparisonExecution(input, evidenceById, resources, {
          signal,
        }),
    },
    compare_javascript_export_shapes: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        compareJavaScriptExportShapesExecution(input, evidenceById, {
          signal,
        }),
    },
    // The ledger refuses Evidence formats through the format owner.
    build_reconstruction_obligation_ledger: {
      admission: "application",
      workflow: async (input) => reconstructionObligationLedgerExecution(input),
    },
    project_android_application_graph: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        settledResult(
          projectAndroidApplicationEvidence(input, evidenceById, { signal }),
        ),
    },
    project_apple_application_graph: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        settledResult(
          projectAppleApplicationEvidence(input, evidenceById, { signal }),
        ),
    },
    project_harmony_application_graph: {
      admission: "sdk",
      workflow: async (input, { signal }) =>
        settledResult(
          projectHarmonyApplicationEvidence(input, evidenceById, { signal }),
        ),
    },
    // Plain results under the same admission as the workflows above.
    evaluate_reconstruction_coverage: {
      admission: "application",
      admitted: true,
      value: async (input) => evaluateReconstructionCoverage(input),
    },
    // The export validates its own request so refusals name the field.
    export_environment_bundle: {
      admission: "application",
      admitted: true,
      value: async (rawInput, { signal }) => {
        const parsed =
          exportEnvironmentBundleContract.inputSchema.safeParse(rawInput);
        return parsed.success
          ? exportEnvironmentBundleTool(parsed.data, evidenceById, {
              signal,
            })
          : err(
              analysisInputErrorFromIssues(
                exportEnvironmentBundleContract.name,
                parsed.error.issues,
                rawInput,
                { cause: parsed.error },
              ),
            );
      },
    },
  };
};

export const bindEnhancedWorkflowTools = ({
  session,
}: {
  readonly session: WorkflowSession | undefined;
}): ContractToolBindings => ({
  trace_native_values: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "trace_native_values", input },
        analysis,
        session,
        request,
      ),
  },
  inspect_native_dispatch_metadata: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "inspect_native_dispatch_metadata", input },
        analysis,
        session,
        request,
      ),
  },
  get_objc_classes: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "get_objc_classes", input },
        analysis,
        session,
        request,
      ),
  },
  get_objc_protocols: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "get_objc_protocols", input },
        analysis,
        session,
        request,
      ),
  },
  batch_decompile: {
    admission: "sdk",
    detail: "delivery",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "batch_decompile", input },
        analysis,
        session,
        request,
      ),
  },
  decompile_all: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "decompile_all", input },
        analysis,
        session,
        request,
      ),
  },
  get_call_graph: {
    admission: "sdk",
    detail: "delivery",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "get_call_graph", input },
        analysis,
        session,
        request,
      ),
  },
  analyze_swift_types: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "analyze_swift_types", input },
        analysis,
        session,
        request,
      ),
  },
  find_xrefs_to_name: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "find_xrefs_to_name", input },
        analysis,
        session,
        request,
      ),
  },
  binary_overview: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "binary_overview", input },
        analysis,
        session,
        request,
      ),
  },
  inspect_native_api: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "inspect_native_api", input },
        analysis,
        session,
        request,
      ),
  },
  trace_feature: {
    admission: "sdk",
    detail: "delivery",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "trace_feature", input },
        analysis,
        session,
        request,
      ),
  },
  trace_call_path: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "trace_call_path", input },
        analysis,
        session,
        request,
      ),
  },
  trace_native_ui_action: {
    admission: "sdk",
    analyze: (input, analysis, request) =>
      executeSessionWorkflowEvidence(
        { name: "trace_native_ui_action", input },
        analysis,
        session,
        request,
      ),
  },
  analyze_function: {
    admission: "sdk",
    detail: "delivery",
    analyze: (input, analysis, request) =>
      executeSessionFunctionAnalysis(input, analysis, session, request),
  },
});

export const bindSessionRecordTools = ({
  session,
  resources,
}: SessionDerivedToolOptions): ContractToolBindings => ({
  export_evidence_bundle: {
    admission: "sdk",
    admitted: true,
    value: async (input, { signal }) => {
      const bundle = session.immutableEvidenceBundle();
      const written = await writeEvidenceBundle(
        bundle,
        input.path,
        input.overwrite,
        resources,
        signal,
      );
      return written.ok
        ? ok(evidenceBundleExportReceipt(bundle, written.value))
        : written;
    },
  },
  import_evidence_bundle: {
    admission: "sdk",
    admitted: true,
    value: async (input, { signal }) => {
      const loaded = await readImmutableEvidenceBundle(
        input.path,
        signal,
        resources,
        "import_evidence_bundle",
      );
      if (!loaded.ok) return loaded;
      if (signal.aborted)
        return err(cancelledBy("import_evidence_bundle", signal));
      const imported = session.importEvidenceBundle(loaded.value);
      return imported.ok
        ? ok({
            imported: imported.value.recordsAdded,
            unknowns_added: imported.value.unknownsAdded,
            total: imported.value.totalRecords,
          })
        : imported;
    },
  },
  get_evidence_bundle: {
    admission: "sdk",
    admitted: true,
    value: async (input) =>
      inspectEvidenceBundle(session.immutableEvidenceBundle(), input),
  },
  list_unknowns: {
    admission: "sdk",
    admitted: true,
    value: async (input) =>
      ok(
        session.listUnknownsPage({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.domain === undefined ? {} : { domain: input.domain }),
          offset: input.offset,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
  },
  record_unknown: {
    admission: "sdk",
    admitted: true,
    value: async (input) => committedUnknown(session.recordUnknown(input)),
  },
  update_unknown: {
    admission: "sdk",
    admitted: true,
    value: async (input) => committedUnknown(session.updateUnknown(input)),
  },
  verify_unknown_resolution: {
    admission: "sdk",
    admitted: true,
    value: async (input) => session.verifyUnknownResolution(input.unknown_id),
  },
});
