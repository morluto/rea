import { angrLoadOptions } from "./AngrProtocolValues.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type {
  AnalysisClient,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { Result } from "../domain/result.js";
import {
  readAngrConfiguration,
  type AngrConfiguration,
} from "./AngrConfiguration.js";
import {
  createAngrMcpConnection,
  type AngrMcpConnection,
} from "./AngrMcpConnection.js";
import {
  angrCapabilities,
  ANGR_PROVIDER_IDENTITY,
} from "./AngrProviderCapabilities.js";
import { AngrSessionClient } from "./AngrSessionClient.js";

/** Bring-your-own angr MCP candidate; discovery performs no provider startup. */
export class AngrProvider implements AnalysisProviderCandidate {
  #registration: Result<AngrConfiguration, ConfigurationError> | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    private readonly config: AppConfig,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly connectionFactory: (
      config: AngrConfiguration,
      environment: Readonly<NodeJS.ProcessEnv>,
    ) => AngrMcpConnection = createAngrMcpConnection,
  ) {
    this.environment = snapshotEnvironment(environment);
  }

  identity() {
    return ANGR_PROVIDER_IDENTITY;
  }
  capabilities() {
    const config = this.#configuration();
    return angrCapabilities(
      config.ok ? config.value.mode : "headless",
      config.ok && "url" in config.value ? "http" : "stdio",
    );
  }
  inspectAvailability(): ProviderAvailability {
    const config = this.#configuration();
    if (config.ok)
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          configured: true,
          mode: config.value.mode,
          transport: "command" in config.value ? "stdio" : "http",
          live_connection_probed: false,
        },
      };
    const configured =
      this.config.angrMcpConfigPath !== undefined ||
      this.config.angrPythonPath !== undefined;
    return {
      status: "unavailable",
      code: !configured
        ? "not_configured"
        : this.config.angrMcpConfigPath === undefined
          ? "executable_missing"
          : "open_options_invalid",
      reason: config.error.message,
      diagnostics: { configured, live_connection_probed: false },
    };
  }
  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason:
          "angr admits executable inputs, not analysis databases or archives. Select the original input binary.",
        diagnostics,
      };
    if (target.format === "mach-o-universal")
      return {
        status: "unsupported", code: "target_format_unsupported",
        reason: "angr architecture selection cannot establish the caller-selected universal slice offset and size. Select a thin executable.", diagnostics,
      };
    if (target.format === "raw-binary" && Object.keys(angrLoadOptions(target)).length === 0)
      return {
        status: "unsupported", code: "target_format_unsupported",
        reason: "The selected raw-image architecture has no supported angr loader mapping.", diagnostics,
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }
  async resolveAnalysisProfile(
    _target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError("angr:profile"));
    const config = this.#configuration();
    if (!config.ok) return config;
    return ok({
      profile: createAnalysisProfile(ANGR_PROVIDER_IDENTITY, {
        version_scope: "rea-angr-adapter",
        engine_version: null,
        mode: config.value.mode,
        transport: "command" in config.value ? "stdio" : "http",
        auto_load_libs: config.value.autoLoadLibs,
        cfg: { normalize: true, data_references: true },
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
    return new AngrSessionClient(
      config.value,
      target,
      this.connectionFactory(config.value, this.environment),
      profile,
    );
  }
  #configuration() {
    this.#registration ??= readAngrConfiguration({
      mcpConfigPath: this.config.angrMcpConfigPath,
      pythonPath: this.config.angrPythonPath,
    });
    return this.#registration;
  }
}
