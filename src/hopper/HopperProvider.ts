import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
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
import type { AppConfig } from "../config/types.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Logger } from "pino";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { HopperApplicationLauncher } from "./BridgeLauncher.js";
import {
  hopperLoaderArgsForTarget,
  resolveHopperAnalysisProfile,
} from "./HopperAnalysisProfile.js";
import { mapHopperFileOffset } from "./HopperFileOffset.js";
import { HopperRegexSearch } from "./HopperRegexSearch.js";
import { HopperClient } from "./HopperClient.js";
import { hopperMachOImageSchema } from "./HopperMachOImage.js";

import {
  CAPABILITIES,
  HOPPER_PROVIDER_IDENTITY,
} from "./HopperProviderCapabilities.js";

/** Concrete analysis provider backed by REA's private Hopper bridge. */
export class HopperProvider implements AnalysisProviderCandidate {
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  /**
   * Host platform, injected so availability and launch-mode decisions can be
   * exercised for any host rather than only the machine running the suite.
   * Mirrors `GhidraProvider`, which already threads its installation host's
   * platform the same way.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.environment = snapshotEnvironment(environment, platform);
  }

  identity(): ProviderIdentity {
    return HOPPER_PROVIDER_IDENTITY;
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
      provider: HOPPER_PROVIDER_IDENTITY,
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
                HOPPER_PROVIDER_IDENTITY.id,
                operation,
                `Hopper cannot open ${target.kind} targets directly. Inventory or extract the artifact first.`,
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      };
    const preparation = profile?.parameters.prepared_image;
    const parsedImage =
      preparation === undefined
        ? undefined
        : hopperMachOImageSchema.safeParse(preparation);
    if (parsedImage?.success === false)
      return {
        execute: (operation) =>
          Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                HOPPER_PROVIDER_IDENTITY.id,
                operation,
                "Hopper prepared-image profile is malformed; resolve the analysis profile again.",
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      };
    const preparedImage = parsedImage?.data;
    const container =
      preparedImage === undefined
        ? profile?.parameters.macho_container
        : "thin";
    const derivedLoaderArgs = hopperLoaderArgsForTarget(
      target,
      container === "thin" || container === "fat32" || container === "fat64"
        ? container
        : undefined,
    );
    if (!derivedLoaderArgs.ok)
      return {
        execute: () => Promise.resolve(err(derivedLoaderArgs.error)),
        close: () => Promise.resolve(ok(null)),
      };
    const executionProvider = profile?.provider ?? HOPPER_PROVIDER_IDENTITY;
    const client = new HopperClient({
      launcher: new HopperApplicationLauncher({
        environment: this.environment,
        launcherPath: this.config.hopperLauncherPath,
        targetPath: target.path,
        targetKind: target.kind,
        ...(preparedImage === undefined
          ? {}
          : {
              preparedImage: {
                image: preparedImage,
                sourceSha256: target.sha256,
              },
            }),
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
    const regexSearch = new HopperRegexSearch(client);
    return {
      execute: async (operation, parameters, options) => {
        const result =
          (operation === "search_strings" ||
            operation === "search_procedures") &&
          parameters.mode === "regex"
            ? await regexSearch.execute(operation, parameters, options)
            : await client.callTool(operation, parameters, options);
        if (!result.ok) return result;
        const mapped =
          operation === "address_to_file_offset"
            ? await mapHopperFileOffset(target, result.value, options?.signal)
            : result;
        return mapped.ok
          ? {
              ok: true,
              value: createAnalysisExecution(mapped.value, executionProvider, {
                // Only the file-offset mapping differs from Hopper's reply.
                rawResult: mapped === result ? null : result.value,
                ...(profile === undefined ? {} : { analysisProfile: profile }),
                limitations: [
                  ...(preparedImage === undefined
                    ? []
                    : [
                        "REA loaded a verified thin Mach-O slice from the original FAT64 source. Identity and file offsets refer to the original file. The owned temporary image and its Hopper document close together, including on MCP shutdown.",
                      ]),
                  ...(CAPABILITIES.find(
                    (descriptor) => descriptor.operation === operation,
                  )?.limitations ?? []),
                  ...(operation === "read_bytes"
                    ? [
                        "Hopper byte reads stop at the containing segment's exclusive end; a readable prefix is returned with complete=false when the requested range crosses it.",
                      ]
                    : []),
                  ...(operation === "procedure_references"
                    ? [
                        "Native CallReference classifications and unresolved targets are preserved. Detailed reference flags and coverage beyond reported CallReference objects remain unknown.",
                      ]
                    : []),
                ],
              }),
            }
          : mapped;
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
      close: async (options) => {
        await regexSearch.close();
        return client.close(options);
      },
    };
  }
}
