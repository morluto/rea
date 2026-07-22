import { parseConfig } from "../config.js";
import { projectAnalysisError } from "../domain/errors.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  createServerIdentity,
  createServerIdentitySummary,
} from "../serverIdentity.js";
import { silentLogger, type Logger } from "../logger.js";
import { createBinarySession } from "./runtime.js";

const runSessionStatus = async (
  logger: Logger = silentLogger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
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

/** List provider identities, selection, and availability without capability bodies. */
export const runProviderStatus = async (
  logger: Logger = silentLogger,
  detail: "summary" | "full" = "summary",
): Promise<JsonValue> => {
  const fullStatus = await runSessionStatus(logger);
  if (detail === "full") return fullStatus;
  const parsedStatus = jsonObjectSchema.safeParse(fullStatus);
  if (!parsedStatus.success || parsedStatus.data.error !== undefined)
    return fullStatus;
  const status = parsedStatus.data;
  return {
    open: status.open ?? false,
    provider: status.provider ?? null,
    providers: status.providers ?? [],
    analysis_provider_binding: status.analysis_provider_binding ?? null,
    analysis_provider_candidates: projectJsonObjectArray(
      status.analysis_provider_candidates,
      ["provider", "availability", "target_support", "selected"],
    ),
    server_identity: createServerIdentitySummary({
      startedAt: new Date().toISOString(),
    }),
  };
};

/** List concise operation availability, with explicit full descriptor opt-in. */
export const runCapabilityStatus = async (
  logger: Logger = silentLogger,
  detail: "summary" | "full" = "summary",
): Promise<JsonValue> => {
  const fullStatus = await runSessionStatus(logger);
  if (detail === "full") return fullStatus;
  const parsedStatus = jsonObjectSchema.safeParse(fullStatus);
  if (!parsedStatus.success || parsedStatus.data.error !== undefined)
    return fullStatus;
  const status = parsedStatus.data;
  const capabilities = projectJsonObjectArray(status.capabilities, [
    "operation",
    "available",
    "reason",
  ]);
  const available = capabilities.filter(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "available" in candidate &&
      candidate.available === true,
  ).length;
  return {
    open: status.open ?? false,
    summary: {
      total: capabilities.length,
      available,
      unavailable: capabilities.length - available,
    },
    capabilities,
    analysis_provider_binding: status.analysis_provider_binding ?? null,
    server_identity: createServerIdentitySummary({
      startedAt: new Date().toISOString(),
    }),
  };
};

const projectJsonObjectArray = (
  value: JsonValue | undefined,
  keys: readonly string[],
): JsonValue[] =>
  Array.isArray(value)
    ? value.map((candidate) => {
        const parsed = jsonObjectSchema.safeParse(candidate);
        if (!parsed.success) return candidate;
        return Object.fromEntries(
          keys.flatMap((key) =>
            parsed.data[key] === undefined ? [] : [[key, parsed.data[key]]],
          ),
        );
      })
    : [];
