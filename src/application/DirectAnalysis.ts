import type { ExecutableFormatHint } from "../domain/dosCom.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { executeFunctionAnalysisEvidence } from "./FunctionAnalysisEvidence.js";
import type { DirectAnalysisDependencies } from "./DirectAnalysisDependencies.js";
import type { BinarySession } from "./binary/BinarySession.js";
import type { SessionProviderRoute } from "./binary/SessionProviderRouter.js";
import type { ResolvedSessionOpen } from "./binary/BinarySessionOpen.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/native/nativeToolContracts.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import {
  isManagedToolName,
  type ManagedToolName,
} from "../contracts/managed/managedToolContracts.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { access } from "node:fs/promises";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "./binary/AnalysisSnapshotFiles.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  snapshotEvidenceForQuery,
  snapshotMatchesTarget,
} from "../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type {
  AnalysisExecution,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "./InvestigationProviders.js";
import {
  createWorkflowEvidence,
  workflowSnapshotRecord,
  recordWorkflowUnknowns,
} from "./WorkflowEvidence.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import { resolveXrefsAddress } from "./XrefsAddressResolution.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  directAnalysisCleanupFailure,
  managedAnalysisCleanupFailure,
  withSessionCleanup,
} from "./DirectAnalysisCleanup.js";

type DirectAnalysisTool =
  | "annotate_native_function"
  | "inspect_native_load_image"
  | "read_bytes"
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
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    }),
  );

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  dependencies: DirectAnalysisDependencies,
  ...[path, tool, arguments_, logger = silentLogger, signal]: readonly [
    path: string,
    tool: NativeToolName | ArtifactAnalysisOperation | ManagedToolName,
    arguments_: Readonly<Record<string, JsonValue>>,
    logger?: Logger,
    signal?: AbortSignal,
  ]
): Promise<JsonValue> =>
  isManagedToolName(tool)
    ? runManagedProviderAnalysis(dependencies, path, tool, signal)
    : withProcessCancellation(signal, (operationSignal) =>
        runAnalysis(dependencies, path, tool, arguments_, {
          logger,
          snapshotPath: undefined,
          signal: operationSignal,
        }),
      );

/** Execute managed metadata inspection in an isolated managed-only session. */
export const runManagedProviderExecution = async (
  dependencies: Pick<DirectAnalysisDependencies, "createManagedBinarySession">,
  path: string,
  tool: ManagedToolName,
  signal?: AbortSignal,
): Promise<Result<AnalysisExecution, AnalysisError>> =>
  withProcessCancellation(signal, async (operationSignal) => {
    const session = dependencies.createManagedBinarySession();
    return withSessionCleanup(
      session,
      async () => {
        const opened = await session.open(path, { signal: operationSignal });
        if (!opened.ok) return opened;
        return await session.execute(tool, {}, { signal: operationSignal });
      },
      managedAnalysisCleanupFailure,
    );
  });

const runManagedProviderAnalysis = async (
  dependencies: DirectAnalysisDependencies,
  path: string,
  tool: ManagedToolName,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const execution = await runManagedProviderExecution(
    dependencies,
    path,
    tool,
    signal,
  );
  if (!execution.ok) return cliError(execution.error);
  const value = execution.value;
  return createEvidence(value.subject ?? undefined, value.provider, {
    operation: tool,
    parameters: {},
    result: value.result,
    rawResult: value.rawResult,
    limitations: value.limitations,
    locations: value.locations,
  });
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
    readonly providerId?: AnalysisProviderSelector;
    readonly formatHint?: ExecutableFormatHint;
  },
): Promise<JsonValue> => {
  const { logger, signal, snapshotPath } = options;
  const config = dependencies.readConfiguration();
  if (!config.ok) return cliError(config.error);
  const session = dependencies.createBinarySession(config.value, logger);
  return withSessionCleanup(
    session,
    async () => {
      const prepared = await prepareSnapshot({
        path,
        snapshotPath,
        signal,
        ...(options.formatHint === undefined
          ? {}
          : { formatHint: options.formatHint }),
      });
      if (!prepared.ok) return cliError(prepared.error);
      const { snapshot } = prepared.value;
      let resolvedTarget: ResolvedSessionOpen | undefined;
      if (snapshot !== undefined && prepared.value.target !== undefined) {
        const preview = await session.previewTarget(prepared.value.target, {
          signal,
          snapshot,
          ...(options.formatHint === undefined
            ? {}
            : { formatHint: options.formatHint }),
          ...(options.providerId === undefined
            ? {}
            : { providerId: options.providerId }),
        });
        if (!preview.ok) return cliError(preview.error);
        resolvedTarget = preview.value;
        const route = preview.value.route;
        const bindingProfile = route.profile ?? undefined;
        const evidenceProfile = analysisProfileForRoute(route, tool);
        if (
          bindingProfile !== undefined &&
          evidenceProfile !== undefined &&
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
          if (cached !== undefined) return cached;
        }
      }
      const openOptions = {
        signal,
        ...(options.formatHint === undefined
          ? {}
          : { formatHint: options.formatHint }),
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(options.providerId === undefined
          ? {}
          : { providerId: options.providerId }),
      };
      const opened =
        resolvedTarget === undefined
          ? await session.open(path, openOptions)
          : await session.openResolvedTarget(resolvedTarget, openOptions);
      if (!opened.ok) return cliError(opened.error);
      const evidenceProfile = analysisProfileForEvidence(session, tool);
      const { output, evidence } = await executeAnalysisTool({
        session,
        openedTarget: opened.value,
        tool,
        arguments: arguments_,
        signal,
        evidenceProfile,
      });
      if (evidence !== undefined) {
        const recorded = session.recordEvidence(evidence);
        if (!recorded.ok)
          return cliError(recorded.error.retainPartialObservation(evidence));
        if (isWorkflowEvidenceTool(tool)) {
          const unknowns = recordWorkflowUnknowns({
            name: tool,
            result: evidence.normalized_result,
            evidenceId: evidence.evidence_id,
            recordUnknown: (unknown) => session.recordUnknown(unknown),
          });
          if (!unknowns.ok)
            return cliError(unknowns.error.retainPartialObservation(evidence));
        }
      }
      if (
        isWorkflowEvidenceTool(tool) &&
        tool !== "trace_native_ui_action" &&
        snapshotPath !== undefined &&
        evidence !== undefined &&
        session.allowsSnapshotReplay(tool)
      ) {
        const workflowRecord = workflowSnapshotRecord(evidence, tool);
        if (workflowRecord !== undefined) {
          const recorded = session.recordWorkflowSnapshot(workflowRecord);
          if (!recorded.ok)
            return cliError(recorded.error.retainPartialObservation(evidence));
        }
      }
      if (
        tool !== "trace_native_ui_action" &&
        snapshotPath !== undefined &&
        evidence !== undefined
      ) {
        const snapshot = session.exportAnalysisSnapshot();
        if (!snapshot.ok)
          return cliError(snapshot.error.retainPartialObservation(evidence));
        const written = await writeAnalysisSnapshot(
          snapshot.value,
          snapshotPath,
          true,
        );
        if (!written.ok)
          return cliError(written.error.retainPartialObservation(evidence));
      }
      return output;
    },
    directAnalysisCleanupFailure,
  );
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
}): Promise<{ readonly output: JsonValue; readonly evidence?: Evidence }> => {
  const { session, tool, signal, evidenceProfile } = input;
  if (tool === "analyze_function") {
    const result = await executeFunctionAnalysisEvidence(
      session,
      input.arguments,
      input.openedTarget,
      { signal },
    );
    return result.ok
      ? { output: result.value, evidence: result.value }
      : { output: cliError(result.error) };
  }
  if (
    tool === "binary_overview" ||
    tool === "inspect_native_api" ||
    tool === "inspect_native_dispatch_metadata" ||
    tool === "trace_feature" ||
    tool === "trace_native_values" ||
    tool === "trace_native_ui_action"
  ) {
    const result = await new EnhancedTools(session).execute(
      tool,
      input.arguments,
      signal,
    );
    if (!result.ok) return { output: cliError(result.error) };
    const evidence = createWorkflowEvidence({
      target: input.openedTarget,
      operation: tool,
      parameters: input.arguments,
      result: result.value,
      upstreamProfile: evidenceProfile,
    });
    return { output: evidence, evidence };
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
    if (!address.ok) return { output: cliError(address.error) };
    if (address.value !== input.arguments.address)
      result = await session.execute(
        tool,
        { ...input.arguments, address: address.value },
        { signal },
      );
  }
  if (!result.ok) return { output: cliError(result.error) };
  const evidence = createEvidence(
    result.value.subject ?? input.openedTarget,
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
      locations: result.value.locations,
      evidenceLinks:
        tool === "inspect_artifact"
          ? artifactInspectionResultSchema.parse(result.value.result)
              .evidence_links
          : [],
    },
  );
  return { output: evidence, evidence };
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
  const loaded = await readAnalysisSnapshot(snapshotPath);
  if (!loaded.ok) return loaded;
  const target = await parseBinaryTarget(path, {
    signal: options.signal,
    ...(options.formatHint === undefined
      ? {}
      : { formatHint: options.formatHint }),
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
  if (profile === null || profile === undefined) return undefined;
  if (isWorkflowEvidenceTool(tool))
    return workflowAnalysisProfile(profile, tool);
  const provider = providerIdentityForRoute(route, tool);
  return provider.id === profile.provider.id ? profile : undefined;
};

/** Mirror BinarySession.providerIdentity for a route not opened yet. */
const providerIdentityForRoute = (
  route: SessionProviderRoute,
  operation: string,
): ProviderIdentity => {
  const selected =
    route.capabilities?.get(operation)?.provider ?? route.identity;
  return route.profile?.provider.id === selected.id
    ? route.profile.provider
    : selected;
};

const analysisProfileForEvidence = (
  session: BinarySession,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): AnalysisProfileCommitment | undefined => {
  if (!isWorkflowEvidenceTool(tool)) return session.analysisProfile(tool);
  return session.analysisProfile();
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
