import { parseConfig, type AppConfig } from "../config.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { createBinarySession } from "./runtime.js";
import { silentLogger, type Logger } from "../logger.js";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactToolName } from "../contracts/artifactToolContracts.js";
import {
  EvidenceIntegrityError,
  AnalysisProtocolError,
  PermissionRequiredError,
  projectAnalysisError,
  type AnalysisError,
} from "../domain/errors.js";
import { access } from "node:fs/promises";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "./AnalysisSnapshotFiles.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  snapshotEvidenceForQuery,
  snapshotMatchesTarget,
} from "../domain/analysisSnapshot.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import { loadConfiguredPermissionAuthority } from "./PermissionConfiguration.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import {
  authorizeFileReadWithDeferredWrite,
  type DeferredFileWriteAuthorization,
} from "./DeferredFileAuthorization.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "./InvestigationProviders.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";

type DirectAnalysisTool =
  | "binary_overview"
  | "procedure_pseudo_code"
  | "analyze_function"
  | "search_strings"
  | "search_procedures"
  | "xrefs"
  | "trace_feature";

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
    readonly permissionAuthority?: PermissionAuthority;
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
      ...(options.permissionAuthority === undefined
        ? {}
        : { permissionAuthority: options.permissionAuthority }),
    }),
  );

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  path: string,
  tool: NativeToolName | ArtifactToolName,
  arguments_: Readonly<Record<string, JsonValue>>,
  logger: Logger = silentLogger,
  signal?: AbortSignal,
): Promise<JsonValue> =>
  withProcessCancellation(signal, (operationSignal) =>
    runAnalysis(path, tool, arguments_, {
      logger,
      snapshotPath: undefined,
      signal: operationSignal,
    }),
  );

/** Describe configured providers without opening a target or starting one. */
export const runSessionStatus = async (
  logger: Logger = silentLogger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const session = createBinarySession(config.value, logger);
  try {
    return {
      ...jsonObjectSchema.parse(session.status()),
      server_identity: createServerIdentity({
        startedAt: new Date().toISOString(),
      }),
    };
  } finally {
    await session.close();
  }
};

const authorizeAnalysis = async (
  authority: PermissionAuthority,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
): Promise<Result<null, AnalysisError>> => {
  const requests = [];
  if (tool === "extract_artifact" && typeof arguments_.output_root === "string")
    requests.push({
      capability: "artifact_extract" as const,
      path: arguments_.output_root,
      access: "write" as const,
    });
  for (const request of requests) {
    const result = await authority.authorize(
      {
        capability: request.capability,
        roots: [request.path],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: `${tool}:${request.capability}:${request.path}`,
      },
      request.access,
    );
    if (!result.ok)
      return err(
        result.error instanceof PermissionRequiredError
          ? result.error
          : new AnalysisProtocolError(result.error.message, {
              cause: result.error,
            }),
      );
  }
  if (
    tool === "inventory_artifact" &&
    arguments_.native_mount_approved === true
  ) {
    const result = await authority.authorize(
      {
        capability: "native_mount",
        roots: [],
        executables: [],
        environment_names: [],
        network: "none",
        mount: true,
        operation_identity: "inventory_artifact:native_mount",
      },
      "read",
    );
    if (!result.ok)
      return err(
        result.error instanceof PermissionRequiredError
          ? result.error
          : new AnalysisProtocolError(result.error.message, {
              cause: result.error,
            }),
      );
  }
  return ok(null);
};

const permissionAuthorityFor = (
  config: AppConfig,
  supplied: PermissionAuthority | undefined,
): ReturnType<typeof loadConfiguredPermissionAuthority> =>
  supplied === undefined
    ? loadConfiguredPermissionAuthority(config)
    : Promise.resolve(ok(supplied));

const authorizeSnapshotAccess = async (
  authority: PermissionAuthority,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
  snapshotPath: string | undefined,
): Promise<
  Result<DeferredFileWriteAuthorization | undefined, AnalysisError>
> =>
  snapshotPath === undefined
    ? ok(undefined)
    : authorizeFileReadWithDeferredWrite(authority, {
        path: snapshotPath,
        readCapability: "snapshot_read",
        writeCapability: "snapshot_write",
        operation: tool,
      });

const authorizeDeferredWrite = (
  authorization: DeferredFileWriteAuthorization | undefined,
): Promise<Result<null, AnalysisError>> =>
  authorization?.authorizeWrite() ?? Promise.resolve(ok(null));

const authorizeAnalysisRun = async (input: {
  readonly config: AppConfig;
  readonly suppliedAuthority: PermissionAuthority | undefined;
  readonly tool: NativeToolName | ArtifactToolName | DirectAnalysisTool;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly snapshotPath: string | undefined;
}): Promise<
  Result<DeferredFileWriteAuthorization | undefined, AnalysisError>
> => {
  const authority = await permissionAuthorityFor(
    input.config,
    input.suppliedAuthority,
  );
  if (!authority.ok) return authority;
  const operation = await authorizeAnalysis(
    authority.value,
    input.tool,
    input.arguments,
  );
  if (!operation.ok) return operation;
  return authorizeSnapshotAccess(
    authority.value,
    input.tool,
    input.snapshotPath,
  );
};

const runAnalysis = async (
  path: string,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger: Logger;
    readonly snapshotPath: string | undefined;
    readonly signal: AbortSignal;
    readonly permissionAuthority?: PermissionAuthority;
    readonly providerId?: AnalysisProviderSelector;
  },
): Promise<JsonValue> => {
  const { logger, signal, snapshotPath } = options;
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const authorization = await authorizeAnalysisRun({
    config: config.value,
    suppliedAuthority: options.permissionAuthority,
    tool,
    arguments: arguments_,
    snapshotPath,
  });
  if (!authorization.ok) return cliError(authorization.error);
  const session = createBinarySession(config.value, logger);
  try {
    const prepared = await prepareSnapshot({
      path,
      snapshotPath,
      policy: config.value.analysisSnapshotFilePolicy,
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
    const writable = await authorizeDeferredWrite(authorization.value);
    if (!writable.ok) return cliError(writable.error);
    let output: JsonValue;
    let evidence: Evidence | undefined;
    if (
      tool === "binary_overview" ||
      tool === "analyze_function" ||
      tool === "trace_feature"
    ) {
      const result = await new EnhancedTools(session).execute(
        tool,
        arguments_,
        signal,
      );
      if (!result.ok) output = cliError(result.error);
      else {
        evidence = createEvidence(
          opened.value,
          tool === "analyze_function"
            ? session.providerIdentity(tool)
            : REA_WORKFLOW_PROVIDER,
          {
            operation: tool,
            parameters: arguments_,
            result: result.value,
            ...(evidenceProfile === undefined
              ? {}
              : { analysisProfile: evidenceProfile }),
            confidence: "derived",
            limitations: ["Derived by an REA composed workflow."],
          },
        );
        output = evidence;
      }
    } else {
      const result = await session.execute(tool, arguments_, { signal });
      if (!result.ok) output = cliError(result.error);
      else {
        evidence = createEvidence(
          result.value.subject ?? opened.value,
          result.value.provider,
          {
            operation: tool,
            parameters: arguments_,
            result: result.value.result,
            ...(result.value.analysisProfile === undefined
              ? {}
              : { analysisProfile: result.value.analysisProfile }),
            rawResult: result.value.rawResult,
            limitations: result.value.limitations,
            locations: result.value.locations,
          },
        );
        output = evidence;
      }
    }
    if (evidence !== undefined) session.recordEvidence(evidence);
    if (snapshotPath !== undefined && evidence !== undefined) {
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok) return cliError(snapshot.error);
      const written = await writeAnalysisSnapshot(
        snapshot.value,
        snapshotPath,
        true,
        config.value.analysisSnapshotFilePolicy,
      );
      if (!written.ok) return cliError(written.error);
    }
    return output;
  } finally {
    await session.close();
  }
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
  readonly policy: Parameters<typeof readAnalysisSnapshot>[1];
}): Promise<
  Result<{ readonly snapshot?: AnalysisSnapshot }, AnalysisError>
> => {
  const { path, snapshotPath, policy } = options;
  if (snapshotPath === undefined || !(await fileExists(snapshotPath)))
    return ok({});
  const loaded = await readAnalysisSnapshot(snapshotPath, policy);
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
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
) =>
  tool === "binary_overview" || tool === "trace_feature"
    ? REA_WORKFLOW_PROVIDER
    : session.providerIdentity(tool);

const analysisProfileForEvidence = (
  session: ReturnType<typeof createBinarySession>,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
): AnalysisProfileCommitment | undefined => {
  if (tool !== "binary_overview" && tool !== "trace_feature")
    return session.analysisProfile(tool);
  const upstream = session.analysisProfile();
  return upstream === undefined ? undefined : workflowAnalysisProfile(upstream);
};

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
