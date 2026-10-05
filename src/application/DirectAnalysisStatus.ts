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

/** List complete provider identities, capabilities, and availability. */
export const runProviderStatus = (
  logger: Logger = silentLogger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => runSessionStatus(logger, environment);

/** List complete operation descriptors and availability. */
export const runCapabilityStatus = (
  logger: Logger = silentLogger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => runSessionStatus(logger, environment);
