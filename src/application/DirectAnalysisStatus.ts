import { parseConfig } from "../config.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { silentLogger, type Logger } from "../logger.js";
import { createBinarySession } from "./runtime.js";

const runSessionStatus = async (
  logger: Logger = silentLogger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<JsonValue> => {
  const config = parseConfig(environment);
  if (!config.ok) return { error: projectAnalysisError(config.error) };
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

/** List binary-session provider candidates and auxiliary operation availability. */
export const runProviderStatus = (
  logger: Logger = silentLogger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => runSessionStatus(logger, environment);

/** List binary-session operation descriptors; this is not the full MCP catalog. */
export const runCapabilityStatus = (
  logger: Logger = silentLogger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => runSessionStatus(logger, environment);
