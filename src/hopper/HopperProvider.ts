import { fileURLToPath } from "node:url";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
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
import { HopperClient } from "./HopperClient.js";

const IDENTITY: ProviderIdentity = Object.freeze({
  id: "hopper",
  name: "Hopper Disassembler",
  version: null,
});
const MUTATING_OPERATIONS = new Set([
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
]);

const PROVIDER_TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS.filter(
    (contract) => contract.name === "analyze_function",
  ),
];

const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  PROVIDER_TOOL_CONTRACTS.map((contract) =>
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
export class HopperProvider implements AnalysisProvider {
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

  createClient(target: BinaryTarget): AnalysisClient {
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
    const client = new HopperClient({
      launcher: new HopperApplicationLauncher({
        launcherPath: this.config.hopperLauncherPath,
        targetPath: target.path,
        targetKind: target.kind,
        loaderArgs:
          this.config.hopperLoaderArgs.length > 0
            ? this.config.hopperLoaderArgs
            : target.loaderArgs,
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
      logger: this.logger.child({ layer: "bridge" }),
    });
    return {
      execute: async (operation, parameters, options) => {
        const result = await client.callTool(operation, parameters, options);
        return result.ok
          ? {
              ok: true,
              value: createAnalysisExecution(result.value, IDENTITY, {
                limitations: [
                  "Results depend on Hopper's completed static analysis.",
                ],
              }),
            }
          : result;
      },
      close: () => client.close(),
    };
  }
}
