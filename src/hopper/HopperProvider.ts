import { fileURLToPath } from "node:url";
import { accessSync, constants } from "node:fs";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { AppConfig } from "../config.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import { AnalysisCapabilityUnavailableError } from "../domain/errors.js";
import { err } from "../domain/result.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import { HopperApplicationLauncher } from "./BridgeLauncher.js";
import {
  hopperLoaderArgsForTarget,
  resolveHopperAnalysisProfile,
} from "./HopperAnalysisProfile.js";
import { HopperClient } from "./HopperClient.js";

/** Public identity committed by every Hopper-backed observation. */
export const HOPPER_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "hopper",
  name: "Hopper Disassembler",
  version: null,
});
const IDENTITY = HOPPER_PROVIDER_IDENTITY;
const MUTATING_OPERATIONS = new Set([
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
]);

/** Tool contracts implemented directly by the Hopper adapter. */
export const HOPPER_PROVIDER_TOOL_CONTRACTS = Object.freeze([
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS.filter(
    (contract) => contract.name === "analyze_function",
  ),
]);

const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  HOPPER_PROVIDER_TOOL_CONTRACTS.map((contract) =>
    Object.freeze({
      provider: IDENTITY,
      operation: contract.name,
      inputContractVersion: 1,
      outputContractVersion: 1,
      available: true,
      reason: null,
      pagination: "offset" in contract.inputSchema.shape ? "offset" : "none",
      exhaustive: false,
      effects: Object.freeze({
        mutatesArtifact: MUTATING_OPERATIONS.has(contract.name),
        launchesProcess: true,
        mayShowUi: true,
        mayAccessNetwork: false,
        mayWriteFilesystem: MUTATING_OPERATIONS.has(contract.name),
        changesPermissions: false,
        requiresRoot: false,
      }),
      limits: Object.freeze({
        maxResults: null,
        maxPayloadBytes: null,
        timeoutMs: null,
      }),
      limitations: Object.freeze([
        "Results depend on Hopper's completed static analysis.",
      ]),
    }),
  ),
);

/** Concrete analysis provider backed by REA's private Hopper bridge. */
export class HopperProvider implements AnalysisProviderCandidate {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return CAPABILITIES;
  }

  inspectAvailability(): ProviderAvailability {
    const diagnostics = {
      launcher_path: this.config.hopperLauncherPath,
      platform: process.platform,
    };
    if (process.platform !== "darwin" && process.platform !== "linux")
      return {
        status: "unavailable",
        code: "unsupported_host",
        reason: `Hopper integration is not supported on ${process.platform}.`,
        diagnostics,
      };
    try {
      accessSync(this.config.hopperLauncherPath, constants.X_OK);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics,
      };
    } catch {
      return {
        status: "unavailable",
        code: "executable_missing",
        reason: `Hopper launcher is missing or not executable: ${this.config.hopperLauncherPath}`,
        diagnostics,
      };
    }
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
    };
    if (target.kind !== "executable" && target.kind !== "database")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Hopper cannot directly analyze ${target.kind} targets.`,
        diagnostics,
      };
    if (target.kind === "database")
      return {
        status: "supported",
        code: null,
        reason: null,
        diagnostics,
      };
    if (!["mach-o", "elf", "pe"].includes(target.format))
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Hopper cannot open ${target.format} through this adapter.`,
        diagnostics,
      };
    if (target.architecture === undefined)
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason: "Hopper requires a supported concrete target architecture.",
        diagnostics,
      };
    return {
      status: "supported",
      code: null,
      reason: null,
      diagnostics,
    };
  }

  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    return resolveHopperAnalysisProfile(target, {
      launcherPath: this.config.hopperLauncherPath,
      loaderArgsOverride: this.config.hopperLoaderArgs,
      provider: IDENTITY,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    if (target.kind !== "executable" && target.kind !== "database")
      return {
        execute: (operation) =>
          Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                IDENTITY.id,
                operation,
                `Hopper cannot open ${target.kind} targets directly. Inventory or extract the artifact first.`,
              ),
            ),
          ),
        close: () => Promise.resolve(),
      };
    const derivedLoaderArgs = hopperLoaderArgsForTarget(target);
    if (!derivedLoaderArgs.ok)
      return {
        execute: () => Promise.resolve(err(derivedLoaderArgs.error)),
        close: () => Promise.resolve(),
      };
    const executionProvider = profile?.provider ?? IDENTITY;
    const client = new HopperClient({
      launcher: new HopperApplicationLauncher({
        launcherPath: this.config.hopperLauncherPath,
        targetPath: target.path,
        targetKind: target.kind,
        loaderArgs:
          this.config.hopperLoaderArgs.length > 0
            ? this.config.hopperLoaderArgs
            : derivedLoaderArgs.value,
        bridgeScriptPath: fileURLToPath(
          new URL("../../bridge/hopper_bridge.py", import.meta.url),
        ),
        ...(process.platform === "linux"
          ? {
              launchMode: "verified_linux_demo" as const,
              demoHelperPath: fileURLToPath(
                new URL("../../scripts/hopper-demo-x11.py", import.meta.url),
              ),
            }
          : { launchMode: "native" as const }),
      }),
      ...(context === undefined ? {} : { runId: context.runId }),
      logger: this.logger.child({ layer: "bridge" }),
    });
    return {
      execute: async (operation, parameters, options) => {
        const result = await client.callTool(operation, parameters, options);
        return result.ok
          ? {
              ok: true,
              value: createAnalysisExecution(result.value, executionProvider, {
                ...(profile === undefined ? {} : { analysisProfile: profile }),
                limitations: [
                  "Results depend on Hopper's completed static analysis.",
                ],
              }),
            }
          : result;
      },
      runtimeLineageSnapshots: () => {
        const observation = client.runtimeLineage();
        return observation === null
          ? []
          : [{ provider: executionProvider, observation }];
      },
      requestActivitySnapshots: () => {
        const activity = client.requestActivity();
        return [
          {
            provider: executionProvider,
            active:
              activity === null
                ? null
                : {
                    requestId: activity.requestId,
                    operation: activity.operation,
                    elapsedMs: activity.elapsedMs,
                    timeoutMs: activity.timeoutMs,
                    callerState: activity.callerState,
                  },
            queuedRequests: activity?.queuedRequests ?? 0,
          },
        ];
      },
      closeWithOutcome: (options) => client.closeWithOutcome(options),
      close: () => client.close(),
    };
  }
}
