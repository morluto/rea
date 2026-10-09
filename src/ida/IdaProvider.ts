import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type {
  AnalysisClient,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { Result } from "../domain/result.js";
import {
  readIdaConfiguration,
  type IdaConfiguration,
  idaConfigurationError,
} from "./IdaConfiguration.js";
import {
  createIdaMcpConnection,
  type IdaMcpConnection,
} from "./IdaMcpConnection.js";
import {
  idaCapabilities,
  IDA_PROVIDER_IDENTITY,
} from "./IdaProviderCapabilities.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { privateRuntimeRootCapability } from "../process/PrivateRuntimeRoot.js";

export { IDA_PROVIDER_IDENTITY } from "./IdaProviderCapabilities.js";

/** Bring-your-own IDA MCP candidate; discovery performs no provider startup. */
export class IdaProvider implements AnalysisProviderCandidate {
  #registration: Result<IdaConfiguration, ConfigurationError> | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    private readonly config: AppConfig,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly connectionFactory: (
      config: IdaConfiguration,
      environment: Readonly<NodeJS.ProcessEnv>,
    ) => IdaMcpConnection = createIdaMcpConnection,
  ) {
    this.environment = snapshotEnvironment(environment);
  }

  identity() {
    return IDA_PROVIDER_IDENTITY;
  }
  capabilities() {
    const config = this.#configuration();
    return idaCapabilities(
      config.ok ? config.value.mode : "attached",
      config.ok && "command" in config.value,
    );
  }
  inspectAvailability(): ProviderAvailability {
    const config = this.#configuration();
    if (config.ok && config.value.mode === "headless") {
      const privacy = privateRuntimeRootCapability();
      if (!privacy.available)
        return {
          status: "unavailable",
          code: "unsupported_host",
          reason: privacy.reason,
          diagnostics: {
            configured: true,
            mode: "headless",
            live_connection_probed: false,
            private_workspace_available: false,
          },
        };
    }
    return config.ok
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {
            configured: true,
            mode: config.value.mode,
            transport: "command" in config.value ? "stdio" : "http",
            live_connection_probed: false,
          },
        }
      : {
          status: "unavailable",
          code:
            this.config.idaMcpConfigPath === undefined
              ? "not_configured"
              : "open_options_invalid",
          reason: config.error.message,
          diagnostics: { configured: false, live_connection_probed: false },
        };
  }
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    return target.kind === "executable"
      ? { status: "supported", code: null, reason: null, diagnostics }
      : {
          status: "unsupported",
          code: "target_kind_unsupported",
          reason:
            "IDA MCP integration admits executable inputs, not analysis databases. Select the original input binary.",
          diagnostics,
        };
  }
  async resolveAnalysisProfile(
    _target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError("ida:profile"));
    const config = this.#configuration();
    if (!config.ok) return config;
    return ok({
      profile: createAnalysisProfile(IDA_PROVIDER_IDENTITY, {
        version_scope: "rea-ida-adapter",
        engine_version: null,
        upstream_distribution_version: null,
        mode: config.value.mode,
        compatibility_profile:
          config.value.mode === "attached"
            ? "legacy-1.4"
            : "database-supervisor",
        database_revision: null,
        cache_policy: "live",
        registration_digest: createHash("sha256")
          .update(canonicalize(config.value) ?? "")
          .digest("hex"),
      }),
    });
  }
  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const config = this.#configuration();
    if (!config.ok)
      return {
        execute: async () => err(config.error),
        close: async () => ok(null),
      };
    return new IdaSessionClient(
      config.value,
      target,
      this.connectionFactory(config.value, this.environment),
      profile,
    );
  }
  #configuration() {
    this.#registration ??=
      this.config.idaMcpConfigPath === undefined
        ? readIdaConfigurationNotConfigured()
        : readIdaConfiguration(this.config.idaMcpConfigPath);
    return this.#registration;
  }
}

const readIdaConfigurationNotConfigured = () =>
  err(
    idaConfigurationError(
      "Set REA_IDA_MCP_CONFIG to an upstream IDA MCP JSON registration; see docs/ida-provider.md.",
    ),
  );
