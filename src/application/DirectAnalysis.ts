import { parseConfig } from "../config.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { createBinarySession, createManagedBinarySession } from "./runtime.js";
import { silentLogger, type Logger } from "../logger.js";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import {
  isManagedToolName,
  type ManagedToolName,
} from "../contracts/managedToolContracts.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { access } from "node:fs/promises";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "./AnalysisSnapshotFiles.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  snapshotEvidenceForQuery,
  snapshotMatchesTarget,
} from "../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type { AnalysisExecution } from "./AnalysisProvider.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "./InvestigationProviders.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";

export {
  runCapabilityStatus,
  runProviderStatus,
} from "./DirectAnalysisStatus.js";

type DirectAnalysisTool =
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
  path: string,
  tool: DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger?: Logger;
    readonly snapshotPath?: string | undefined;
    readonly signal?: AbortSignal;
    readonly providerId?: AnalysisProviderSelector;
  } = {},
): Promise<JsonValue> =>
  withProcessCancellation(options.signal, (signal) =>
    runAnalysis(path, tool, arguments_, {
      logger: options.logger ?? silentLogger,
      snapshotPath: options.snapshotPath,
      signal,
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    }),
  );

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  ...[path, tool, arguments_, logger = silentLogger, signal]: readonly [
    path: string,
    tool: NativeToolName | ArtifactAnalysisOperation | ManagedToolName,
    arguments_: Readonly<Record<string, JsonValue>>,
    logger?: Logger,
    signal?: AbortSignal,
  ]
): Promise<JsonValue> =>
  isManagedToolName(tool)
    ? runManagedProviderAnalysis(path, tool, signal)
    : withProcessCancellation(signal, (operationSignal) =>
        runAnalysis(path, tool, arguments_, {
          logger,
          snapshotPath: undefined,
          signal: operationSignal,
        }),
      );

/** Execute managed metadata inspection in an isolated managed-only session. */
export const runManagedProviderExecution = async (
  path: string,
  tool: ManagedToolName,
  signal?: AbortSignal,
): Promise<Result<AnalysisExecution, AnalysisError>> =>
  withProcessCancellation(signal, async (operationSignal) => {
    const session = createManagedBinarySession();
    try {
      const opened = await session.open(path, { signal: operationSignal });
      if (!opened.ok) return opened;
      return await session.execute(tool, {}, { signal: operationSignal });
    } finally {
      await session.close();
    }
  });

const runManagedProviderAnalysis = async (
  path: string,
  tool: ManagedToolName,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const execution = await runManagedProviderExecution(path, tool, signal);
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
    /**
     * Environment the configuration is read from. Defaults to the process
     * environment so existing callers are unchanged, but a caller may supply
     * one — which is what lets the MCP path's injected environment reach this
     * code, and what makes configuration-driven behaviour testable without
     * mutating `process.env`.
     */
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<JsonValue> => {
  const { logger, signal, snapshotPath } = options;
  const config = parseConfig(options.environment ?? process.env);
  if (!config.ok) return cliError(config.error);
  const session = createBinarySession(config.value, logger);
  try {
    const prepared = await prepareSnapshot({
      path,
      snapshotPath,
    });
    if (!prepared.ok) return cliError(prepared.error);
    const { snapshot } = prepared.value;
    const opened = await session.open(path, {
      signal,
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    });
    if (!opened.ok) return cliError(opened.error);
    const evidenceProfile = analysisProfileForEvidence(session, tool);
    const bindingProfile = session.analysisProfile();
    if (
      tool !== "trace_native_ui_action" &&
      snapshot !== undefined &&
      evidenceProfile !== undefined &&
      bindingProfile !== undefined
    ) {
      const cached = snapshotEvidenceForQuery(snapshot, {
        target: opened.value,
        bindingProfile,
        operation: tool,
        parameters: arguments_,
        provider: replayProviderFor(session, tool),
        evidenceProfile,
      });
      if (cached !== undefined) return cached;
    }
    const { output, evidence } = await executeAnalysisTool({
      session,
      openedTarget: opened.value,
      tool,
      arguments: arguments_,
      signal,
      evidenceProfile,
    });
    if (evidence !== undefined) session.recordEvidence(evidence);
    if (
      tool !== "trace_native_ui_action" &&
      snapshotPath !== undefined &&
      evidence !== undefined
    ) {
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok) return cliError(snapshot.error);
      const written = await writeAnalysisSnapshot(
        snapshot.value,
        snapshotPath,
        true,
      );
      if (!written.ok) return cliError(written.error);
    }
    return output;
  } finally {
    await session.close();
  }
};

const executeAnalysisTool = async (input: {
  readonly session: ReturnType<typeof createBinarySession>;
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
  if (
    tool === "binary_overview" ||
    tool === "analyze_function" ||
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
    const evidence = createEvidence(
      input.openedTarget,
      tool === "analyze_function"
        ? session.providerIdentity(tool)
        : REA_WORKFLOW_PROVIDER,
      {
        operation: tool,
        parameters: input.arguments,
        result: result.value,
        ...(evidenceProfile === undefined
          ? {}
          : { analysisProfile: evidenceProfile }),
        confidence: "derived",
        limitations: ["Derived by an REA composed workflow."],
      },
    );
    return { output: evidence, evidence };
  }
  const result = await session.execute(tool, input.arguments, { signal });
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
  process.once("SIGINT", cancel);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", cancel);
  }
};

const prepareSnapshot = async (options: {
  readonly path: string;
  readonly snapshotPath: string | undefined;
}): Promise<
  Result<{ readonly snapshot?: AnalysisSnapshot }, AnalysisError>
> => {
  const { path, snapshotPath } = options;
  if (snapshotPath === undefined || !(await fileExists(snapshotPath)))
    return ok({});
  const loaded = await readAnalysisSnapshot(snapshotPath);
  if (!loaded.ok) return loaded;
  const target = await parseBinaryTarget(path);
  if (!target.ok) return target;
  if (!snapshotMatchesTarget(loaded.value.target, target.value))
    return err(
      new EvidenceIntegrityError(
        "Analysis snapshot target does not match the requested binary",
      ),
    );
  return ok({ snapshot: loaded.value });
};

const replayProviderFor = (
  session: ReturnType<typeof createBinarySession>,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
) =>
  isWorkflowEvidenceTool(tool)
    ? REA_WORKFLOW_PROVIDER
    : session.providerIdentity(tool);

const analysisProfileForEvidence = (
  session: ReturnType<typeof createBinarySession>,
  tool:
    | NativeToolName
    | ArtifactAnalysisOperation
    | ManagedToolName
    | DirectAnalysisTool,
): AnalysisProfileCommitment | undefined => {
  if (!isWorkflowEvidenceTool(tool)) return session.analysisProfile(tool);
  const upstream = session.analysisProfile();
  return upstream === undefined ? undefined : workflowAnalysisProfile(upstream);
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
