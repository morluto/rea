import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { z } from "incur";
import { ok } from "../domain/result.js";
import { withEvidenceCallerInputPath } from "../domain/evidence.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { createUnrealPakService } from "../composition/unreal.js";
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
export const registerUnrealCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectUnrealPak, {
    description: "Inventory an Unreal Engine .pak footer and index entries",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local Unreal Engine .pak file (version 1 to 12)",
      ),
    }),
    options: z.object(analysisEvidenceDeliveryOptions),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectUnrealPak, async () => {
          const service = createUnrealPakService();
          return deliverCliAnalysisEvidence({
            run: async () => {
              const result = await service.inspect(
                { path: absoluteCallerPath(args.path), detail: "complete" },
                { signal },
              );
              // Evidence keeps the selection as typed; the service reads its absolute form.
              return result.ok
                ? ok(withEvidenceCallerInputPath(result.value, args.path))
                : result;
            },
            service,
            providerId: "unreal-pak",
            operation: "inspect_unreal_pak",
            signal,
            detail: options.detail,
            evidenceOutput: options.evidence_output,
          });
        }),
      ),
  });
};
