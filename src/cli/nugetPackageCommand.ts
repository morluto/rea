import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { projectArtifactCloseFailure } from "../artifacts/StableArtifactFailure.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  NUGET_PACKAGE_OPERATION as operation,
  NUGET_PACKAGE_PROVIDER,
} from "../domain/nugetPackage/nugetPackage.js";
import {
  nugetPackageEntriesSchema,
  nugetPackageFileBytesSchema,
} from "../domain/nugetPackage/nugetPackageQuery.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const deliverySchema = z.object({
  detail: analysisEvidenceDeliveryOptions.detail,
});

/** One-shot publication keeps the complete inventory for later offline pages. */
export const registerNugetPackageCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectNugetPackage, {
    description:
      "Inspect the contents and .nuspec declarations of a local NuGet package (.nupkg) offline",
    args: z.object({
      path: localPathStringSchema.describe("Local .nupkg path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      // Decimal tokens only: numeric coercion would read "0x10" as 16 and
      // "1e3" as 1000. The shared fields keep their bounds and defaults.
      maxFileBytes: cliDecimalField(nugetPackageFileBytesSchema),
      maxEntries: cliDecimalField(nugetPackageEntriesSchema),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectNugetPackage, async () => {
          const selected = parseCliAnalysisEvidenceDelivery(
            operation,
            options,
            deliverySchema,
          );
          if (!selected.ok) return projectAnalysisError(selected.error);
          const resources = new ArtifactResourceScope();
          const { inspectNugetPackageEvidence } =
            await import("../application/nugetPackage/NugetPackageService.js");
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: async () => {
              const inspected = await inspectNugetPackageEvidence(
                {
                  path: absoluteCallerPath(args.path),
                  format: "nupkg",
                  max_file_bytes: options.maxFileBytes,
                  max_entries: options.maxEntries,
                },
                resources,
                { signal },
              );
              return inspected.ok
                ? { ok: true, value: inspected.value.evidence }
                : inspected;
            },
            service: {
              close: () =>
                resources.close().catch((cause: unknown) => {
                  throw projectArtifactCloseFailure(
                    cause,
                    NUGET_PACKAGE_PROVIDER.id,
                    operation,
                  );
                }),
            },
            providerId: NUGET_PACKAGE_PROVIDER.id,
            operation,
            signal,
            detail: selected.value.detail,
            evidenceOutput: selected.value.evidenceOutput,
          });
        }),
      ),
  });
};
