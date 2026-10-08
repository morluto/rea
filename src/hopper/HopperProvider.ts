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
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { err } from "../domain/result.js";
import { HopperApplicationLauncher } from "./BridgeLauncher.js";
import {
  hopperLoaderArgsForTarget,
  resolveHopperAnalysisProfile,
} from "./HopperAnalysisProfile.js";
import { HopperClient } from "./HopperClient.js";

import {
  CAPABILITIES,
  HOPPER_PROVIDER_IDENTITY,
} from "./HopperProviderCapabilities.js";

export {
  HOPPER_PROVIDER_IDENTITY,
  HOPPER_OPERATIONS,
} from "./HopperProviderCapabilities.js";

const IDENTITY = HOPPER_PROVIDER_IDENTITY;

/** Concrete analysis provider backed by REA's private Hopper bridge. */
export class HopperProvider implements AnalysisProviderCandidate {
  /**
   * Host platform, injected so availability and launch-mode decisions can be
   * exercised for any host rather than only the machine running the suite.
   * Mirrors `GhidraProvider`, which already threads its installation host's
   * platform the same way.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
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
      platform: this.platform,
    };
    if (this.platform !== "darwin" && this.platform !== "linux")
      return {
        status: "unavailable",
        code: "unsupported_host",
        reason: `Hopper integration is not supported on ${this.platform}.`,
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
    } catch (cause: unknown) {
      // best-effort cleanup: optional launcher probing; failure means unavailable.
      void cause;
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
    if (target.format === "dos-mz" || target.format === "dos-com")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "DOS MZ/COM analysis requires the Ghidra 16-bit real-mode adapter.",
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
        ...(this.platform === "linux"
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
      onDiagnostic: (diagnostic) =>
        this.logger.info(diagnostic, "Hopper bridge reported a diagnostic"),
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
                  ...(operation === "read_bytes"
                    ? [
                        "Hopper byte reads stop at the containing segment's exclusive end; a readable prefix is returned with complete=false when the requested range crosses it.",
                      ]
                    : []),
                  ...(operation === "procedure_references"
                    ? [
                        "Hopper's public Python API does not expose flow classification for calls without resolved targets; unresolved_calls is empty and its coverage is unknown.",
                      ]
                    : []),
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
                    callerState: activity.callerState,
                  },
            queuedRequests: activity?.queuedRequests ?? 0,
          },
        ];
      },
      operationHealthSnapshot: () => client.operationHealth(),
      closeWithOutcome: (options) => client.closeWithOutcome(options),
      close: () => client.close(),
    };
  }
}
