import { fileURLToPath } from "node:url";

import type {
  AnalysisClient,
  AnalysisProvider,
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

const CAPABILITIES = [
  "direct-analysis",
  "decompilation",
  "disassembly",
  "cross-references",
  "containing-procedure-resolution",
  "procedure-references",
  "analysis-metadata-mutation",
] as const;

/** Concrete analysis provider backed by REA's private Hopper bridge. */
export class HopperProvider implements AnalysisProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly string[] {
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
