import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AnalysisClient,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  BinaryNinjaMcp,
  redactValue,
  type BinaryNinjaTransportFactory,
} from "./BinaryNinjaMcp.js";
import { BinaryNinjaSession } from "./BinaryNinjaSession.js";
import { BINARY_NINJA_OPERATIONS } from "./BinaryNinjaValues.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../generatedMcpToolCatalog.js";

/** Identity used by CLI/MCP provider selection and Binary Ninja evidence. */
export const BINARY_NINJA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "binary-ninja",
  name: "Binary Ninja",
  version: null,
});

/** Existing REA contracts supported by the Binary Ninja adapter. */
export const BINARY_NINJA_PROVIDER_TOOL_CONTRACTS = Object.freeze(
  BINARY_NINJA_OPERATIONS.map((operation) => {
    const contract = GENERATED_MCP_TOOL_CATALOG.find(
      ({ name }) => name === operation,
    );
    if (contract === undefined)
      throw new TypeError(`Missing REA contract for ${operation}`);
    return contract;
  }),
);

/** Bring-your-own built-in MCP provider; no Binary Ninja installation or license changes. */
export class BinaryNinjaProvider implements AnalysisProviderCandidate {
  constructor(
    private readonly config: AppConfig,
    private readonly transportFactory?: BinaryNinjaTransportFactory,
  ) {}

  identity(): ProviderIdentity {
    return BINARY_NINJA_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return BINARY_NINJA_OPERATIONS.map((operation) => ({
      provider: this.identity(),
      operation,
      available: true,
      reason: null,
      effects: {
        mutatesArtifact: false,
        launchesProcess: this.config.binaryNinjaMcp?.command !== undefined,
        mayShowUi: false,
        mayAccessNetwork: this.config.binaryNinjaMcp?.url !== undefined,
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      },
      limitations: [
        "Requires Binary Ninja's built-in MCP server. Version-dependent tools are checked against the advertised inventory; unsupported roles fail explicitly.",
        "Read-only executable analysis. REA imports a temporary copy and closes its own item; database mutation, saving, GUI controls, and native API/value-flow projection are unavailable.",
      ],
    }));
  }

  inspectAvailability(): ProviderAvailability {
    const connection = this.config.binaryNinjaMcp;
    if (connection === undefined)
      return {
        status: "unavailable",
        code: "not_configured",
        reason:
          "Set REA_BINARY_NINJA_MCP_URL for GUI HTTP or REA_BINARY_NINJA_MCP_COMMAND for headless stdio.",
        diagnostics: {},
      };
    const diagnostics = {
      transport: connection.url === undefined ? "stdio" : "streamable-http",
      endpoint: connection.url ?? connection.command ?? "",
      connection_verified: false,
    };
    if (connection.command !== undefined) {
      try {
        if (!isAbsolute(connection.command))
          throw new TypeError("The MCP command must be absolute");
        accessSync(connection.command, constants.X_OK);
      } catch {
        return {
          status: "unavailable",
          code: "executable_missing",
          reason:
            "The configured Binary Ninja MCP command is missing or not executable.",
          diagnostics,
        };
      }
    }
    return { status: "available", code: null, reason: null, diagnostics };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason:
          "The Binary Ninja MCP adapter currently imports executable files only.",
        diagnostics,
      };
    if (!["elf", "pe", "mach-o"].includes(target.format))
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "This adapter supports ELF, PE, and thin Mach-O; DOS loader profiles have not been implemented.",
        diagnostics,
      };
    if (target.availableArchitectures.length > 1)
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason:
          "Thin the universal Mach-O to the requested architecture before importing it into Binary Ninja.",
        diagnostics,
      };
    if (target.managed === true)
      return {
        status: "unsupported",
        code: "managed_target_unsupported",
        reason: "Use REA's managed provider for .NET assemblies.",
        diagnostics,
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }

  async resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>> {
    const config = this.config.binaryNinjaMcp;
    if (config === undefined)
      return err(
        new ProviderAdapterError("binary-ninja", "resolve_analysis_profile", {
          diagnostics: { reason: "not_configured" },
        }),
      );
    const mcp = new BinaryNinjaMcp(config, this.transportFactory);
    try {
      await mcp.connect(options?.signal);
      const version = mcp.client.getServerVersion()?.version;
      if (version === undefined || version.length === 0)
        return err(
          new ProviderAdapterError("binary-ninja", "resolve_analysis_profile", {
            diagnostics: { reason: "MCP server did not advertise a version" },
          }),
        );
      return ok({
        profile: createAnalysisProfile(
          { ...BINARY_NINJA_PROVIDER_IDENTITY, version },
          {
            adapter_version: "1",
            protocol: "built-in-mcp",
            transport: config.url === undefined ? "stdio" : "streamable-http",
            target_format: target.format,
            architecture: target.architecture ?? null,
            tool_roles: mcp.inventory(),
          },
        ),
        compatibility: {
          tool_roles: mcp.inventory(),
          engine_build_verified: false,
        },
      });
    } catch (cause: unknown) {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError("open_binary"));
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new ProviderAdapterError("binary-ninja", "resolve_analysis_profile", {
          diagnostics: {
            reason: redactValue(
              cause instanceof Error ? cause.message : String(cause),
              config.token,
            ),
          },
        }),
      );
    } finally {
      await mcp.close();
    }
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const config = this.config.binaryNinjaMcp;
    if (config === undefined || profile?.provider.id !== "binary-ninja")
      return {
        execute: () =>
          Promise.resolve(
            err(
              new ProviderAdapterError("binary-ninja", "health", {
                diagnostics: {
                  reason:
                    "A configured connection and selected Binary Ninja analysis profile are required",
                },
              }),
            ),
          ),
        close: () => Promise.resolve(),
      };
    return new BinaryNinjaSession(
      target,
      profile,
      config,
      this.transportFactory,
    );
  }
}
