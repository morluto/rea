import { parseConfig } from "../config.js";
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
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";

const WORKFLOW_PROVIDER = {
  id: "rea-workflow",
  name: "REA composed investigation workflow",
  version: "1",
} as const;

type DirectAnalysisTool =
  | "binary_overview"
  | "procedure_pseudo_code"
  | "analyze_function"
  | "search_strings"
  | "search_procedures"
  | "xrefs"
  | "trace_feature";

/**
 * Open one binary, execute one tool, and always release the bridge session.
 * Unlike MCP mode, every CLI invocation is intentionally isolated and does not
 * retain a target or bridge resources for a subsequent command.
 */
export const runDirectAnalysis = async (
  path: string,
  tool: DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger?: Logger;
    readonly snapshotPath?: string | undefined;
  } = {},
): Promise<JsonValue> =>
  runAnalysis(path, tool, arguments_, {
    logger: options.logger ?? silentLogger,
    snapshotPath: options.snapshotPath,
  });

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  path: string,
  tool: NativeToolName | ArtifactToolName,
  arguments_: Readonly<Record<string, JsonValue>>,
  logger: Logger = silentLogger,
): Promise<JsonValue> =>
  runAnalysis(path, tool, arguments_, { logger, snapshotPath: undefined });

/** Describe configured providers without opening a target or launching Hopper. */
export const runSessionStatus = async (
  logger: Logger = silentLogger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const session = createBinarySession(config.value, logger);
  try {
    return session.status();
  } finally {
    await session.close();
  }
};

const runAnalysis = async (
  path: string,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
  arguments_: Readonly<Record<string, JsonValue>>,
  options: {
    readonly logger: Logger;
    readonly snapshotPath: string | undefined;
  },
): Promise<JsonValue> => {
  const { logger, snapshotPath } = options;
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const unavailable = snapshotUnavailable(
    snapshotPath,
    config.value.hopperLoaderArgs,
  );
  if (unavailable !== undefined) return cliError(unavailable);
  const session = createBinarySession(config.value, logger);
  try {
    const prepared = await prepareSnapshot({
      path,
      tool,
      arguments: arguments_,
      snapshotPath,
      policy: config.value.analysisSnapshotFilePolicy,
      provider: replayProviderFor(session, tool),
    });
    if (!prepared.ok) return cliError(prepared.error);
    if (prepared.value.evidence !== undefined) return prepared.value.evidence;
    const { snapshot } = prepared.value;
    const opened = await session.open(
      path,
      snapshot === undefined ? {} : { snapshot },
    );
    if (!opened.ok) return cliError(opened.error);
    let output: JsonValue;
    let evidence: Evidence | undefined;
    if (
      tool === "binary_overview" ||
      tool === "analyze_function" ||
      tool === "trace_feature"
    ) {
      const result = await new EnhancedTools(session).execute(tool, arguments_);
      if (!result.ok) output = cliError(result.error);
      else {
        evidence = createEvidence(
          opened.value,
          tool === "analyze_function"
            ? session.providerIdentity(tool)
            : WORKFLOW_PROVIDER,
          {
            operation: tool,
            parameters: arguments_,
            result: result.value,
            confidence: "derived",
            limitations: ["Derived by an REA composed workflow."],
          },
        );
        output = evidence;
      }
    } else {
      const result = await session.execute(tool, arguments_);
      if (!result.ok) output = cliError(result.error);
      else {
        evidence = createEvidence(
          result.value.subject ?? opened.value,
          result.value.provider,
          {
            operation: tool,
            parameters: arguments_,
            result: result.value.result,
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

const prepareSnapshot = async (options: {
  readonly path: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly snapshotPath: string | undefined;
  readonly policy: Parameters<typeof readAnalysisSnapshot>[1];
  readonly provider: Parameters<typeof snapshotEvidenceForQuery>[1]["provider"];
}): Promise<
  Result<
    { readonly snapshot?: AnalysisSnapshot; readonly evidence?: Evidence },
    AnalysisError
  >
> => {
  const {
    path,
    tool,
    arguments: arguments_,
    snapshotPath,
    policy,
    provider,
  } = options;
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
  const evidence = snapshotEvidenceForQuery(loaded.value, {
    target: target.value,
    operation: tool,
    parameters: arguments_,
    provider,
  });
  return ok(
    evidence === undefined
      ? { snapshot: loaded.value }
      : { snapshot: loaded.value, evidence },
  );
};

const snapshotUnavailable = (
  snapshotPath: string | undefined,
  loaderArgs: readonly string[],
): EvidenceIntegrityError | undefined =>
  snapshotPath !== undefined && loaderArgs.length > 0
    ? new EvidenceIntegrityError(
        "Analysis snapshots are unavailable with custom Hopper loader arguments",
      )
    : undefined;

const replayProviderFor = (
  session: ReturnType<typeof createBinarySession>,
  tool: NativeToolName | ArtifactToolName | DirectAnalysisTool,
) =>
  tool === "binary_overview" || tool === "trace_feature"
    ? WORKFLOW_PROVIDER
    : session.providerIdentity(tool);

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
