import type { ExecutableFormatHint } from "../domain/dosCom.js";
import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { DirectAnalysisDependencies } from "./DirectAnalysisDependencies.js";
import type { BinarySession } from "./binary/BinarySession.js";
import type { SessionProviderRoute } from "./binary/SessionProviderRouter.js";
import type { ResolvedSessionOpen } from "./binary/BinarySessionOpen.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/native/nativeToolContracts.js";
import {
  ARTIFACT_ANALYSIS_OPERATIONS,
  type ArtifactAnalysisOperation,
} from "../contracts/artifactToolContracts.js";
import {
  isManagedToolName,
  type ManagedToolName,
} from "../contracts/managed/managedToolContracts.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { access, stat } from "node:fs/promises";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { readAnalysisSnapshot } from "./binary/AnalysisSnapshotFiles.js";
import { requiresNativeSourceAdmissionBeforeReplay } from "./binary/AnalysisSnapshotCache.js";
import {
  classifyBinaryTargetFilesystemFailure,
  parseBinaryTarget,
} from "./BinaryTargetResolver.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  snapshotEvidenceForQuery,
  snapshotMatchesTarget,
} from "../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { profilelessNativeDispatchProfile } from "./binary/ProfilelessNativeWorkflowSnapshot.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type {
  AnalysisExecution,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "./AnalysisProvider.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "./InvestigationProviders.js";
import {
  executeComposedWorkflow,
  createWorkflowEvidence,
  workflowSnapshotRecord,
  recordWorkflowUnknowns,
} from "./WorkflowEvidence.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import { resolveXrefsAddress } from "./XrefsAddressResolution.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { deliverAnalysisEvidence } from "./EvidenceBundleCommands.js";
import type { BinaryTargetError } from "../domain/configurationErrors.js";
import {
  directAnalysisCleanupFailure,
  managedAnalysisCleanupFailure,
  withSessionCleanup,
} from "./DirectAnalysisCleanup.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";
import { BUNDLE_RESOURCE_OPERATIONS } from "./binary/BundleResourceSession.js";

type DirectAnalysisTool =
  | "annotate_native_function"
  | "inspect_native_load_image"
  | "read_bytes"
  | "search_bytes"
  | "address_to_file_offset"
  | "binary_overview"
  | "procedure_pseudo_code"
  | "read_function_instructions"
  | "inspect_native_instruction"
  | "inspect_native_data_type"
  | "resolve_native_call_targets"
  | "analyze_function"
  | "inspect_native_api"
  | "inspect_native_dispatch_metadata"
  | "search_strings"
  | "search_procedures"
  | "xrefs"
  | "trace_feature"
  | "trace_native_ui_action"
  | "trace_native_values";

// These one-shot CLI questions require native utilities, not a deep engine.
// Runtime observation retains the ordinary session and authority checks.
const NATIVE_INSPECTION_OPERATIONS: ReadonlySet<string> = new Set([
  "inspect_macho",
  "inspect_signature",
  "list_architectures",
  "inspect_plist",
  "demangle_swift",
] satisfies readonly NativeToolName[]);

const ARTIFACT_ANALYSIS_OPERATION_SET: ReadonlySet<string> = new Set(
  ARTIFACT_ANALYSIS_OPERATIONS,
);
/**
 * Open one binary, execute one tool, and always release provider resources.
 * Unlike MCP mode, every CLI invocation is intentionally isolated and does not
 * retain a target or provider client for a subsequent command.
 */
export const runDirectAnalysis = async (
  dependencies: DirectAnalysisDependencies,
  path: string,
  tool: DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger?: Logger;
    readonly snapshotPath?: string | undefined;
    readonly signal?: AbortSignal;
    readonly providerId?: AnalysisProviderSelector;
    readonly formatHint?: ExecutableFormatHint;
    readonly architecture?: BinaryArchitecture;
    readonly entryPoint?: string;
  } = {},
): Promise<JsonValue> =>
  withProcessCancellation(options.signal, (signal) =>
    runAnalysis(dependencies, path, tool, arguments_, {
      logger: options.logger ?? silentLogger,
      snapshotPath: options.snapshotPath,
      signal,
      ...(options.formatHint === undefined
        ? {}
        : { formatHint: options.formatHint }),
      ...(options.architecture === undefined
        ? {}
        : { architecture: options.architecture }),
      ...(options.entryPoint === undefined
        ? {}
        : { entryPoint: options.entryPoint }),
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    }),
  );

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  dependencies: DirectAnalysisDependencies,
  ...[path, tool, arguments_, logger = silentLogger, signal, delivery]:
    | readonly [
        path: string,
        tool: NativeToolName | ArtifactAnalysisOperation | ManagedToolName,
        arguments_: Readonly<Record<string, JsonValue>>,
        logger?: Logger | undefined,
        signal?: AbortSignal | undefined,
      ]
    | readonly [
        path: string,
        tool: "inspect_managed_members",
        arguments_: Readonly<Record<string, JsonValue>>,
        logger: Logger | undefined,
        signal: AbortSignal | undefined,
        delivery: {
          readonly detail?: "complete" | "summary";
          readonly evidenceBundlePath?: string;
        },
      ]
): Promise<JsonValue> => {
  if (delivery !== undefined && tool !== "inspect_managed_members")
    return cliError(
      new AnalysisInputError(tool, undefined, [
        {
          path: ["delivery"],
          reason: "invalid_value",
          message:
            "Evidence delivery options are only supported by inspect_managed_members",
        },
      ]),
    );
  if (
    delivery?.detail === "summary" &&
    delivery.evidenceBundlePath === undefined
  )
    return cliError(
      new AnalysisInputError(tool, undefined, [
        {
          path: ["evidence_bundle"],
          reason: "missing_argument",
          message:
            "summary detail requires --evidence-bundle so complete Evidence remains available to later CLI commands",
        },
      ]),
    );
  return withProcessCancellation(signal, async (operationSignal) => {
    if (isManagedToolName(tool)) {
      const original = await runManagedProviderAnalysis(
        dependencies,
        path,
        tool,
        arguments_,
        operationSignal,
      );
      await dispatchQueuedInterrupts();
      if (!original.ok) return cliError(original.error);
      if (operationSignal.aborted)
        return cliError(
          new AnalysisCancelledError(tool, {
            cause: operationSignal.reason,
            partialObservation: original.value,
          }),
        );
      const result =
        delivery?.evidenceBundlePath === undefined
          ? original
          : await deliverAnalysisEvidence(
              original.value,
              delivery.evidenceBundlePath,
              delivery.detail,
              operationSignal,
            );
      return result.ok ? result.value : cliError(result.error);
    }
    return runAnalysis(dependencies, path, tool, arguments_, {
      logger,
      snapshotPath: undefined,
      signal: operationSignal,
      ...(ARTIFACT_ANALYSIS_OPERATION_SET.has(tool)
        ? { createSession: dependencies.createArtifactBinarySession }
        : NATIVE_INSPECTION_OPERATIONS.has(tool)
          ? { createSession: dependencies.createNativeBinarySession }
          : {}),
    });
  });
};

/** Execute managed metadata inspection in an isolated managed-only session. */
export const runManagedProviderExecution = async (
  dependencies: Pick<DirectAnalysisDependencies, "createManagedBinarySession">,
  path: string,
  tool: ManagedToolName,
  signal?: AbortSignal,
  parameters: Readonly<Record<string, JsonValue>> = {},
): Promise<Result<AnalysisExecution, AnalysisError>> =>
  withProcessCancellation(signal, async (operationSignal) => {
    const session = await dependencies.createManagedBinarySession();
    return withSessionCleanup(
      session,
      async () => {
        const opened = await session.open(path, { signal: operationSignal });
        if (!opened.ok) return opened;
        return await session.execute(tool, parameters, {
          signal: operationSignal,
        });
      },
      managedAnalysisCleanupFailure,
    );
  });

/** Preserve typed managed Evidence before selecting its CLI delivery. */
const runManagedProviderAnalysis = async (
  dependencies: Pick<DirectAnalysisDependencies, "createManagedBinarySession">,
  path: string,
  tool: ManagedToolName,
  arguments_: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  const execution = await runManagedProviderExecution(
    dependencies,
    path,
    tool,
    signal,
    arguments_,
  );
  if (!execution.ok) return execution;
  const value = execution.value;
  return ok(
    createAnalysisExecutionEvidence(tool, arguments_, value, "observed", {
      immutable: true,
    }),
  );
};

const runAnalysis = async (
  dependencies: DirectAnalysisDependencies,
  path: string,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger: Logger;
    readonly snapshotPath: string | undefined;
    readonly signal: AbortSignal;
    readonly createSession?: () => BinarySession | Promise<BinarySession>;
    readonly providerId?: AnalysisProviderSelector;
    readonly formatHint?: ExecutableFormatHint;
    readonly architecture?: BinaryArchitecture;
    readonly entryPoint?: string;
  },
): Promise<JsonValue> => {
  const { logger, signal, snapshotPath } = options;
  let session: BinarySession;
  if (options.createSession !== undefined) {
    session = await options.createSession();
  } else {
    const config = dependencies.readConfiguration();
    if (!config.ok) return cliError(config.error);
    session = await (
      tool === "inspect_native_dispatch_metadata" && snapshotPath === undefined
        ? dependencies.createNativeDispatchBinarySession
        : dependencies.createBinarySession
    )(config.value, logger);
  }
  let publishedSnapshot: PublishedEvidenceFile | undefined;
  const execute = async (): Promise<Result<Evidence, AnalysisError>> => {
    let isDirectory = false;
    if (BUNDLE_RESOURCE_OPERATIONS.has(tool)) {
      const inspected = await inspectBundleResourceInput(path);
      if (!inspected.ok) return err(inspected.error);
      isDirectory = inspected.value;
    }
    if (BUNDLE_RESOURCE_OPERATIONS.has(tool) && isDirectory) {
      const opened = await session.openBundleResources(path, { signal });
      if (!opened.ok) return err(opened.error);
      const execution = await session.execute(tool, arguments_, { signal });
      if (!execution.ok) return err(execution.error);
      return ok(
        createAnalysisExecutionEvidence(
          tool,
          arguments_,
          execution.value,
          "observed",
        ),
      );
    }
    const prepared = await prepareSnapshot({
      path,
      snapshotPath,
      signal,
      ...(options.formatHint === undefined
        ? {}
        : { formatHint: options.formatHint }),
      ...(options.architecture === undefined
        ? {}
        : { architecture: options.architecture }),
      ...(options.entryPoint === undefined
        ? {}
        : { entryPoint: options.entryPoint }),
    });
    if (!prepared.ok) return err(prepared.error);
    const { snapshot } = prepared.value;
    let resolvedTarget: ResolvedSessionOpen | undefined;
    if (snapshot !== undefined && prepared.value.target !== undefined) {
      const preview = await session.previewTarget(prepared.value.target, {
        signal,
        snapshot,
        ...(options.formatHint === undefined
          ? {}
          : { formatHint: options.formatHint }),
        ...(options.architecture === undefined
          ? {}
          : { architecture: options.architecture }),
        ...(options.entryPoint === undefined
          ? {}
          : { entryPoint: options.entryPoint }),
        ...(options.providerId === undefined
          ? {}
          : { providerId: options.providerId }),
      });
      if (!preview.ok) return err(preview.error);
      resolvedTarget = preview.value;
      const route = preview.value.route;
      const bindingProfile =
        route.profile ?? nativeDispatchBindingProfile(route, tool);
      const evidenceProfile = analysisProfileForRoute(route, tool);
      // A parsed Windows path does not prove Ghidra's native snapshot owner
      // admitted the selected source; CLI replay must wait for that client.
      if (
        bindingProfile !== undefined &&
        evidenceProfile !== undefined &&
        !requiresNativeSourceAdmissionBeforeReplay(
          route.binding?.identity.id,
        ) &&
        allowsSnapshotReplay(route, tool)
      ) {
        const cached = snapshotEvidenceForQuery(snapshot, {
          target: preview.value.target,
          bindingProfile,
          operation: tool,
          parameters: arguments_,
          provider: isWorkflowEvidenceTool(tool)
            ? REA_WORKFLOW_PROVIDER
            : providerIdentityForRoute(route, tool),
          evidenceProfile,
        });
        if (cached !== undefined) return ok(cached);
      }
    }
    const openOptions = {
      signal,
      ...(options.formatHint === undefined
        ? {}
        : { formatHint: options.formatHint }),
      ...(options.architecture === undefined
        ? {}
        : { architecture: options.architecture }),
      ...(options.entryPoint === undefined
        ? {}
        : { entryPoint: options.entryPoint }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    };
    const opened =
      resolvedTarget === undefined
        ? await session.open(path, openOptions)
        : await session.openResolvedTarget(resolvedTarget, openOptions);
    if (!opened.ok) return err(opened.error);
    const evidenceProfile = analysisProfileForEvidence(session, tool);
    const executed = await executeAnalysisTool({
      session,
      openedTarget: opened.value,
      tool,
      arguments: arguments_,
      signal,
      evidenceProfile,
    });
    if (!executed.ok) return executed;
    const { evidence, cachePolicy } = executed.value;
    const recorded = session.recordEvidence(evidence);
    if (!recorded.ok)
      return err(recorded.error.retainPartialObservation(evidence));
    if (isWorkflowEvidenceTool(tool)) {
      const unknowns = recordWorkflowUnknowns({
        name: tool,
        result: evidence.normalized_result,
        evidenceId: evidence.evidence_id,
        recordUnknown: (unknown) => session.recordUnknown(unknown),
      });
      if (!unknowns.ok)
        return err(unknowns.error.retainPartialObservation(evidence));
    }
    if (
      isWorkflowEvidenceTool(tool) &&
      tool !== "trace_native_ui_action" &&
      snapshotPath !== undefined &&
      session.allowsSnapshotReplay(tool)
    ) {
      const workflowRecord = workflowSnapshotRecord(
        evidence,
        tool,
        evidenceProfile,
        cachePolicy,
      );
      if (workflowRecord !== undefined) {
        const recorded = session.recordWorkflowSnapshot(workflowRecord);
        if (!recorded.ok)
          return err(recorded.error.retainPartialObservation(evidence));
      }
    }
    if (tool !== "trace_native_ui_action" && snapshotPath !== undefined) {
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok)
        return err(snapshot.error.retainPartialObservation(evidence));
      const written = await session.writeAnalysisSnapshot(
        snapshot.value,
        snapshotPath,
        true,
      );
      if (written.ok) publishedSnapshot = written.value;
      else {
        if (written.error instanceof EvidenceFileError)
          publishedSnapshot = written.error.published;
        const recovered =
          written.error instanceof EvidenceFileError &&
          written.error.published !== undefined &&
          (await session.closeFileResources()).ok;
        if (!recovered)
          return err(written.error.retainPartialObservation(evidence));
      }
    }
    return ok(evidence);
  };
  const outcome = await withSessionCleanup<{
    readonly result: Result<Evidence, AnalysisError>;
    readonly cleanupError?: AnalysisError;
  }>(
    session,
    async () => ({ result: await execute() }),
    (value, cleanupError) => ({ ...value, cleanupError }),
  );
  await dispatchQueuedInterrupts();
  const result = outcome.result.ok
    ? completeProviderEvidence(outcome.result.value, signal)
    : outcome.result;
  if (!result.ok && publishedSnapshot !== undefined)
    result.error.retainDiagnostics({
      analysis_snapshot: { ...publishedSnapshot },
    });
  if (outcome.cleanupError !== undefined) {
    // A committed snapshot remains published even when final close fails.
    if (result.ok && publishedSnapshot !== undefined)
      outcome.cleanupError.retainDiagnostics({
        analysis_snapshot: { ...publishedSnapshot },
      });
    return directAnalysisCleanupFailure(result, outcome.cleanupError);
  }
  return result.ok ? result.value : cliError(result.error);
};

const executeAnalysisTool = async (input: {
  readonly session: BinarySession;
  readonly openedTarget: BinaryTarget;
  readonly tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
  readonly evidenceProfile: AnalysisProfileCommitment | undefined;
}): Promise<
  Result<
    {
      readonly evidence: Evidence;
      readonly cachePolicy?: "live";
    },
    AnalysisError
  >
> => {
  const { session, tool, signal, evidenceProfile } = input;
  if (tool === "analyze_function") {
    const { executeFunctionAnalysisEvidence } =
      await import("./FunctionAnalysisEvidence.js");
    const result = await executeFunctionAnalysisEvidence(
      session,
      input.arguments,
      input.openedTarget,
      { signal },
    );
    return result.ok ? ok({ evidence: result.value }) : result;
  }
  if (
    tool === "binary_overview" ||
    tool === "inspect_native_api" ||
    tool === "inspect_native_dispatch_metadata" ||
    tool === "trace_feature" ||
    tool === "trace_native_values" ||
    tool === "trace_native_ui_action"
  ) {
    const { EnhancedTools } = await import("./EnhancedTools.js");
    const result = await executeComposedWorkflow(session, (observed) =>
      new EnhancedTools(observed).execute(tool, input.arguments, signal),
    );
    if (!result.ok) return result;
    const evidence = createWorkflowEvidence({
      target: input.openedTarget,
      operation: tool,
      parameters: input.arguments,
      result: result.value.result,
      upstreamProfile: evidenceProfile,
      upstreamLimitations: result.value.limitations,
    });
    return ok({
      evidence,
      ...(result.value.cachePolicy === undefined
        ? {}
        : { cachePolicy: result.value.cachePolicy }),
    });
  }
  let result = await session.execute(tool, input.arguments, { signal });
  if (
    tool === "xrefs" &&
    typeof input.arguments.address === "string" &&
    !result.ok &&
    result.error instanceof AnalysisInputError &&
    !result.error.cleanupIncomplete &&
    result.error.issues.length > 0 &&
    result.error.issues.every(
      ({ path, reason }) =>
        path.length === 1 &&
        path[0] === "address" &&
        reason === "invalid_format",
    )
  ) {
    const address = await resolveXrefsAddress(
      session,
      input.arguments.address,
      signal,
    );
    if (!address.ok) return address;
    if (address.value !== input.arguments.address)
      result = await session.execute(
        tool,
        { ...input.arguments, address: address.value },
        { signal },
      );
  }
  if (!result.ok) return result;
  const evidence = createEvidence(
    result.value.subject === undefined
      ? input.openedTarget
      : (result.value.subject ?? undefined),
    result.value.provider,
    {
      operation: tool,
      parameters: input.arguments,
      result: result.value.result,
      ...(result.value.analysisProfile === undefined
        ? {}
        : { analysisProfile: result.value.analysisProfile }),
      rawResult: result.value.rawResult,
      limitations: result.value.limitations,
      ...(result.value.relationshipCoverage === undefined
        ? {}
        : { relationshipCoverage: result.value.relationshipCoverage }),
      locations: result.value.locations,
      evidenceLinks:
        tool === "inspect_artifact"
          ? artifactInspectionResultSchema.parse(result.value.result)
              .evidence_links
          : [],
    },
  );
  return ok({ evidence });
};

const withProcessCancellation = async <Value>(
  suppliedSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> => {
  if (suppliedSignal !== undefined) return operation(suppliedSignal);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  // Package runners can forward a terminal interrupt after REA already received
  // it directly. Keep both guards installed until provider cleanup has settled.
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
};

const prepareSnapshot = async (options: {
  readonly path: string;
  readonly formatHint?: ExecutableFormatHint;
  readonly architecture?: BinaryArchitecture;
  readonly entryPoint?: string;
  readonly snapshotPath: string | undefined;
  readonly signal: AbortSignal;
}): Promise<
  Result<
    { readonly snapshot?: AnalysisSnapshot; readonly target?: BinaryTarget },
    AnalysisError
  >
> => {
  const { path, snapshotPath } = options;
  if (snapshotPath === undefined || !(await fileExists(snapshotPath)))
    return ok({});
  const loaded = await readAnalysisSnapshot(snapshotPath, options.signal);
  if (!loaded.ok) return loaded;
  const target = await parseBinaryTarget(path, {
    signal: options.signal,
    ...(options.formatHint === undefined
      ? {}
      : { formatHint: options.formatHint }),
    ...(options.architecture === undefined
      ? {}
      : { architecture: options.architecture }),
    ...(options.entryPoint === undefined
      ? {}
      : { entryPoint: options.entryPoint }),
  });
  if (!target.ok) return target;
  if (!snapshotMatchesTarget(loaded.value.target, target.value))
    return err(
      new EvidenceIntegrityError(
        "Analysis snapshot target does not match the requested binary",
      ),
    );
  return ok({ snapshot: loaded.value, target: target.value });
};

const inspectBundleResourceInput = async (
  path: string,
): Promise<Result<boolean, BinaryTargetError>> => {
  const callerPath = absoluteCallerPath(path);
  try {
    return ok((await stat(callerPath)).isDirectory());
  } catch (cause: unknown) {
    const failure = classifyBinaryTargetFilesystemFailure(callerPath, cause);
    if (failure !== undefined) return err(failure);
    throw cause;
  }
};

const allowsSnapshotReplay = (
  route: SessionProviderRoute,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): boolean => {
  if (tool === "trace_native_ui_action") return false;
  const descriptor = route.capabilities?.get(tool);
  return descriptor === undefined
    ? ![...(route.capabilities?.values() ?? [])].some(
        ({ cachePolicy }) => cachePolicy === "live",
      )
    : descriptor.cachePolicy !== "live";
};

const analysisProfileForRoute = (
  route: SessionProviderRoute,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): AnalysisProfileCommitment | undefined => {
  const profile = route.profile;
  const nativeDispatchProfile =
    profile === null || profile === undefined
      ? nativeDispatchBindingProfile(route, tool)
      : undefined;
  if (profile === null || profile === undefined) {
    if (nativeDispatchProfile === undefined) return undefined;
    return isWorkflowEvidenceTool(tool)
      ? workflowAnalysisProfile(nativeDispatchProfile, tool)
      : nativeDispatchProfile;
  }
  if (isWorkflowEvidenceTool(tool))
    return workflowAnalysisProfile(profile, tool);
  const provider = providerIdentityForRoute(route, tool);
  return provider.id === profile.provider.id ? profile : undefined;
};

const nativeDispatchBindingProfile = (
  route: SessionProviderRoute,
  operation: string,
): AnalysisProfileCommitment | undefined => {
  if (operation !== "inspect_native_dispatch_metadata") return undefined;
  return profilelessNativeDispatchProfile(route);
};

/** Mirror BinarySession.providerIdentity for a route not opened yet. */
const providerIdentityForRoute = (
  route: SessionProviderRoute,
  operation: string,
): ProviderIdentity =>
  route.capabilities?.get(operation)?.provider ?? route.identity;

const analysisProfileForEvidence = (
  session: BinarySession,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): AnalysisProfileCommitment | undefined => {
  if (!isWorkflowEvidenceTool(tool)) return session.analysisProfile(tool);
  return session.analysisProfile() ?? session.analysisProfile(tool);
};

const isWorkflowEvidenceTool = (
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): boolean =>
  tool === "binary_overview" ||
  tool === "inspect_native_api" ||
  tool === "inspect_native_dispatch_metadata" ||
  tool === "trace_feature" ||
  tool === "trace_native_values" ||
  tool === "trace_native_ui_action";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return false;
    throw cause;
  }
};

const cliError = (error: AnalysisError): JsonValue => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
