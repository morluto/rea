import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";
import { createUnityAddressablesService } from "../composition/unityAddressables.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

/** CLI and MCP share inspection; one-shot summaries preserve a complete Evidence file. */
export const registerUnityAddressablesCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectUnityAddressables, {
    description:
      "Inventory a Unity Addressables catalog (catalog.json or catalog.bin): keys, locations, providers, dependencies and bundle hash/CRC",
    args: z.object({
      path: localPathStringSchema.describe("Local catalog.json or catalog.bin"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      hash: localPathStringSchema
        .optional()
        .describe("catalog.hash file to record next to the catalog; read only"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectUnityAddressables,
          async () => {
            const service = createUnityAddressablesService();
            return deliverCliAnalysisEvidence({
              run: () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    detail: "complete" as const,
                    ...(options.hash === undefined
                      ? {}
                      : { hash_path: absoluteCallerPath(options.hash) }),
                  },
                  { signal },
                ),
              service,
              callerInputPath: args.path,
              providerId: "unity-addressables",
              operation: "inspect_unity_addressables",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            });
          },
        ),
      ),
  });
};
