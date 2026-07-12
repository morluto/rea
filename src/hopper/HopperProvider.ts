import { fileURLToPath } from "node:url";

import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import { HopperApplicationLauncher } from "./BridgeLauncher.js";
import { HopperClient } from "./HopperClient.js";

const IDENTITY: ProviderIdentity = {
  id: "hopper",
  name: "Hopper Disassembler",
  version: null,
};

const OPERATIONS = [
  "direct-analysis",
  "decompilation",
  "disassembly",
  "cross-references",
  "containing-procedure-resolution",
  "procedure-references",
  "analysis-metadata-mutation",
] as const;

const CAPABILITIES: readonly CapabilityDescriptor[] = OPERATIONS.map(
  (operation) => ({
    operation,
    version: 1,
    available: true,
    pagination: "none",
    exhaustive: false,
    effects: {
      mutatesArtifact: operation === "analysis-metadata-mutation",
      launchesProcess: true,
      mayShowUi: true,
      mayAccessNetwork: false,
      mayWriteFilesystem: operation === "analysis-metadata-mutation",
      requiresPrivileges: false,
    },
    limitations: ["Results depend on Hopper's completed static analysis."],
  }),
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
      }),
      logger: this.logger.child({ layer: "bridge" }),
    });
    return {
      execute: (operation, parameters, options) =>
        client.callTool(operation, parameters, options),
      close: () => client.close(),
    };
  }
}
