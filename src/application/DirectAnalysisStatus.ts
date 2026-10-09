import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import type { DirectAnalysisDependencies } from "./DirectAnalysisDependencies.js";

/** Read target-free provider status and operation availability. */
export const runSessionStatus = async (
  dependencies: Pick<
    DirectAnalysisDependencies,
    "createBinarySession" | "readConfiguration"
  >,
  logger: Logger = silentLogger,
): Promise<JsonValue> => {
  const config = dependencies.readConfiguration();
  if (!config.ok) return { error: projectAnalysisError(config.error) };
  const session = dependencies.createBinarySession(config.value, logger);
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
