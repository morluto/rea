import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createNugetNupkgService } from "../composition/nugetNupkg.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectNugetNupkgInputSchema } from "../domain/nuget/nupkg.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { cliDecimalField } from "./options.js";

/** Inspect operator-selected NuGet packages through the same shared workflow as MCP. */
export const registerNugetNupkgCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectNugetNupkg, {
    description:
      "Inspect NuGet .nupkg identity, dependency groups and ZIP contents without restore or network",
    args: z.object({
      path: localPathStringSchema.describe("Local NuGet .nupkg package"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectNugetNupkgInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(
        inspectNugetNupkgInputSchema.shape.max_entries,
      ),
      maxNuspecBytes: cliDecimalField(
        inspectNugetNupkgInputSchema.shape.max_nuspec_bytes,
      ),
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createNugetNupkgService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectNugetNupkg,
          async () =>
            deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                    max_nuspec_bytes: options.maxNuspecBytes,
                  },
                  { signal },
                ),
              service,
              providerId: "rea-nuget-nupkg",
              operation: "inspect_nuget_nupkg",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            }),
        );
      }),
  });
};
