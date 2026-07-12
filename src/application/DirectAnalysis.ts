import { parseConfig } from "../config.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { EnhancedTools } from "./EnhancedTools.js";
import { createBinarySession } from "./runtime.js";
import { silentLogger, type Logger } from "../logger.js";
import { createEvidence } from "../domain/evidence.js";
import type { NativeToolName } from "../contracts/nativeToolContracts.js";
import type { ArtifactToolName } from "../contracts/artifactToolContracts.js";

const WORKFLOW_PROVIDER = {
  id: "rea-workflow",
  name: "REA composed investigation workflow",
  version: "1",
} as const;

/**
 * Open one binary, execute one tool, and always release the bridge session.
 * Unlike MCP mode, every CLI invocation is intentionally isolated and does not
 * retain a target or bridge resources for a subsequent command.
 */
export const runDirectAnalysis = async (
  path: string,
  tool: "binary_overview" | "procedure_pseudo_code",
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

const runAnalysis = async (
  path: string,
  tool:
    | NativeToolName
    | ArtifactToolName
    | "binary_overview"
    | "procedure_pseudo_code",
  arguments_: Readonly<Record<string, JsonValue>>,
  logger: Logger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return { error: config.error._tag, message: config.error.message };
  const session = createBinarySession(config.value, logger);
  try {
    const opened = await session.open(path);
    if (!opened.ok)
      return { error: opened.error._tag, message: opened.error.message };
    if (tool === "binary_overview") {
      const result = await new EnhancedTools(session).execute(tool, arguments_);
      return result.ok
        ? createEvidence(opened.value, WORKFLOW_PROVIDER, {
            operation: tool,
            parameters: arguments_,
            result: result.value,
            confidence: "derived",
            limitations: ["Derived by an REA composed workflow."],
          })
        : { error: result.error._tag, message: result.error.message };
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
      : { error: result.error._tag, message: result.error.message };
  } finally {
    await session.close();
  }
};
