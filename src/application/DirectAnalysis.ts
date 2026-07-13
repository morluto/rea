import { parseConfig } from "../config.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { createBinarySession } from "./runtime.js";
import { silentLogger, type Logger } from "../logger.js";
import { createEvidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactToolName } from "../contracts/artifactToolContracts.js";
import { projectAnalysisError, type AnalysisError } from "../domain/errors.js";

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
  logger: Logger = silentLogger,
): Promise<JsonValue> => runAnalysis(path, tool, arguments_, logger);

/** Execute one provider-native semantic operation with atomic provenance. */
export const runProviderAnalysis = async (
  path: string,
  tool: NativeToolName | ArtifactToolName,
  arguments_: Readonly<Record<string, JsonValue>>,
  logger: Logger = silentLogger,
): Promise<JsonValue> => runAnalysis(path, tool, arguments_, logger);

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
  logger: Logger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const session = createBinarySession(config.value, logger);
  try {
    const opened = await session.open(path);
    if (!opened.ok) return cliError(opened.error);
    if (
      tool === "binary_overview" ||
      tool === "analyze_function" ||
      tool === "trace_feature"
    ) {
      const result = await new EnhancedTools(session).execute(tool, arguments_);
      return result.ok
        ? createEvidence(
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
          )
        : cliError(result.error);
    }
    const result = await session.execute(tool, arguments_);
    return result.ok
      ? createEvidence(
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
        )
      : cliError(result.error);
  } finally {
    await session.close();
  }
};

const cliError = (error: AnalysisError): JsonValue => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
