import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import type { DirectAnalysisDependencies } from "./DirectAnalysisDependencies.js";
import { providerCapabilitySet } from "../contracts/toolOutputSchemaPrimitives.js";
import { providerCapabilitySets } from "./binary/BinarySessionStatus.js";
import { sqliteDatabaseCapability } from "./sqlite/SqliteDatabaseCapability.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import { catalogIdentityForToolFamilies } from "../catalogIdentity.js";
import { progressiveCatalogIdentity } from "../catalogDiscovery.js";
import { compactPresentationForMcpInputSchemaProfile } from "../config/mcpInputSchemaProfile.js";
import {
  directAnalysisCleanupFailure,
  projectInvocationFailure,
  withSessionCleanup,
} from "./DirectAnalysisCleanup.js";
import { ok } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/** Read target-free provider status and operation availability. */
export const runSessionStatus = async (
  dependencies: Pick<
    DirectAnalysisDependencies,
    "createBinarySession" | "readConfiguration"
  >,
  logger: Logger = silentLogger,
  view: { readonly operation?: string } = {},
): Promise<JsonValue> => {
  const config = dependencies.readConfiguration();
  if (!config.ok) return { error: projectInvocationFailure(config.error) };
  const session = await dependencies.createBinarySession(config.value, logger);
  return withSessionCleanup<JsonValue>(
    session,
    async () => {
      // The operation view uses the same session projection as MCP; without
      // operation the command keeps its complete provider facts.
      let observed: JsonValue;
      try {
        observed = await session.status(
          view.operation === undefined
            ? {}
            : { detail: "operation", operation: view.operation },
        );
      } catch (cause) {
        if (cause instanceof AnalysisInputError)
          return { error: projectInvocationFailure(cause) };
        throw cause;
      }
      const status = jsonObjectSchema.parse(observed);
      const catalog = catalogIdentityForToolFamilies(
        compactPresentationForMcpInputSchemaProfile(
          config.value.mcpInputSchemaProfile,
        ),
        config.value.mcpOutputSchemaProfile ?? "full",
        config.value.mcpToolFamilies === undefined
          ? undefined
          : new Set(config.value.mcpToolFamilies),
      );
      return {
        ...status,
        capabilities: [
          ...providerCapabilitySet.array().parse(status.capabilities),
          ...providerCapabilitySets([
            sqliteDatabaseCapability(process.versions.node),
          ]),
        ],
        server_identity: createServerIdentity({
          startedAt: new Date().toISOString(),
          commandPath: CURRENT_ENTRYPOINT_PATH,
          catalog:
            config.value.mcpToolCatalogProfile === "hot-cold"
              ? progressiveCatalogIdentity(catalog)
              : catalog,
        }),
      };
    },
    (status, cleanup) => directAnalysisCleanupFailure(ok(status), cleanup),
  );
};
