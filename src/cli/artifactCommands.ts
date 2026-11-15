import {
  espFlashAddressSchema,
  parseEspFlashAddress,
} from "../domain/firmware/espFlashSelection.js";
import type { ArtifactTargetSelection } from "../application/DirectAnalysis.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../domain/investigationProviders.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";
import { producerLimitsOption } from "./producerLimitsOption.js";
import { artifactReaderLimitsInputSchema } from "../domain/artifactReaderLimits.js";

import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactExtractionInputSchema,
} from "../contracts/artifactToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  runOnSessionTarget,
} from "./contractCommand.js";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { registerArtifactComparisonCommand } from "./artifactComparisonCommand.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

const artifactLimitsOption = producerLimitsOption(
  artifactReaderLimitsInputSchema,
  "artifact-limits",
).describe(
  "JSON artifact producer admissions: bun, dotnet_bundle, node_sea, godot, and expanded_bytes. Omitted fields keep defaults; changes apply on the next call without restart. Independent of summary/paging and client delivery limits.",
);

export const registerArtifactCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerInspectionCommand(cli, logger, runProviderAnalysis);
  registerExtractionCommand(cli, logger, runProviderAnalysis);
  registerArtifactComparisonCommand(cli, logger);
  registerAppleBundleCommands(cli, logger, runProviderAnalysis);
};

/** Options that read a dump as an ESP flash image with caller inputs. */
const espFlashSelectionOptions = {
  targetFormat: z
    .enum(["esp-flash-image"])
    .optional()
    .describe(
      "Read the target as an ESP flash dump; required with --flash-offset or --partition-table-offset",
    ),
  flashOffset: espFlashAddressSchema
    .optional()
    .describe("Flash address (0xhex) of the dump's first byte"),
  partitionTableOffset: espFlashAddressSchema
    .optional()
    .describe(
      "Flash address (0xhex, a multiple of 0x1000) of the partition table; disables the table scan",
    ),
};

const espFlashTargetSelection = (options: {
  readonly targetFormat?: "esp-flash-image" | undefined;
  readonly flashOffset?: string | undefined;
  readonly partitionTableOffset?: string | undefined;
}): ArtifactTargetSelection => ({
  ...(options.targetFormat === undefined
    ? {}
    : { formatHint: options.targetFormat }),
  ...(options.flashOffset === undefined &&
  options.partitionTableOffset === undefined
    ? {}
    : {
        espFlash: {
          ...(options.flashOffset === undefined
            ? {}
            : { flashOffset: parseEspFlashAddress(options.flashOffset) }),
          ...(options.partitionTableOffset === undefined
            ? {}
            : {
                partitionTableOffset: parseEspFlashAddress(
                  options.partitionTableOffset,
                ),
              }),
        },
      }),
});

const registerExtractionCommand = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.extractArtifact, {
    description:
      "Extract all or selected regular artifact contents safely; DMG extraction is unavailable",
    args: z.object({
      path: localPathStringSchema.describe("Application or package path"),
    }),
    options: z.object({
      // Incur needs an ordinary optional; keep the owning contract's metadata.
      artifactLimits: artifactLimitsOption,
      outputRoot: artifactExtractionInputSchema.shape.output_root
        .unwrap()
        .optional()
        .meta(artifactExtractionInputSchema.shape.output_root.meta() ?? {}),
      occurrenceId: artifactExtractionInputSchema.shape.occurrence_ids
        .unwrap()
        .optional()
        .describe(
          "Inventory occurrence ID to extract (repeatable); omit to extract all regular entries",
        ),
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
      ...espFlashSelectionOptions,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "extract-artifact", () =>
        runProviderAnalysis(
          args.path,
          "extract_artifact",
          {
            integrity_policy: options.integrityPolicy,
            ...(options.artifactLimits === undefined
              ? {}
              : { artifact_limits: options.artifactLimits }),
            output_root: createArtifactExtractionDestination(
              options.outputRoot,
            ),
            ...(options.occurrenceId === undefined
              ? {}
              : { occurrence_ids: options.occurrenceId }),
          },
          logger,
          undefined,
          undefined,
          espFlashTargetSelection(options),
        ).then(projectCliAnalysisResult),
      ),
  });
};

const registerInspectionCommand = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.inspectArtifact, {
    description:
      "Inspect one artifact and return all available observations and next probes",
    args: z.object({
      path: localPathStringSchema.describe("Application or package path"),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      artifactLimits: artifactLimitsOption,
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
      ...espFlashSelectionOptions,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-artifact", () =>
        withCommandCancellation(async (signal) => {
          const delivery = {
            providerId: ARTIFACT_GRAPH_PROVIDER.id,
            operation: "inspect_artifact",
            signal,
            detail: options.detail,
            evidenceOutput: options.evidence_output,
          };
          const inputError = cliEvidenceDeliveryInputError(delivery);
          if (inputError !== undefined) return projectAnalysisError(inputError);
          const complete = await runProviderAnalysis(
            args.path,
            "inspect_artifact",
            {
              integrity_policy: options.integrityPolicy,
              ...(options.artifactLimits === undefined
                ? {}
                : { artifact_limits: options.artifactLimits }),
            },
            logger,
            signal,
            undefined,
            espFlashTargetSelection(options),
          );
          return publishCliAnalysisEvidence(complete, delivery);
        }),
      ),
  });
};

/**
 * Apple bundle resource commands. Each operation runs on the bundle or
 * Mach-O an MCP session holds open, so the CLI opens it as the session
 * target and passes the rest of the contract input.
 */
const registerAppleBundleCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  const run = runOnSessionTarget(runProviderAnalysis, logger);
  const contract = <
    Name extends (typeof ARTIFACT_TOOL_CONTRACTS)[number]["name"],
  >(
    name: Name,
  ) => contractNamed(ARTIFACT_TOOL_CONTRACTS, name);
  registerContractCommand(
    cli,
    logger,
    contract("inspect_keyed_archive"),
    {
      command: CLI_COMMANDS.inspectKeyedArchive,
      description:
        "Inspect a Foundation keyed archive as an object-reference graph",
      sessionTarget: {
        description: "Foundation plist archive or Apple app bundle",
      },
      positionals: ["path"],
      fields: {
        path: {
          name: "archive",
          description: "Relative archive path when the target is a bundle",
        },
        root: { description: "Named $top archive root" },
        offset: { description: "First original object-table index" },
        limit: { description: "Maximum object-table entries to return" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("trace_dylib_resolution"),
    {
      command: CLI_COMMANDS.traceDylibResolution,
      description:
        "Trace dyld load-path resolution for a Mach-O or every executable in an app bundle",
      sessionTarget: { description: "Mach-O file or Apple .app bundle path" },
      fields: {
        roots: {
          name: "root",
          description:
            "Process root relative to the bundle or the Mach-O's directory (repeatable)",
        },
        architecture: { description: "Trace only this slice of each root" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_asset_catalog"),
    {
      command: CLI_COMMANDS.inspectAssetCatalog,
      description: "Inspect compiled Apple asset catalog metadata",
      sessionTarget: { description: "Apple .app bundle path" },
      fields: {
        offset: { description: "First metadata record" },
        limit: { description: "Maximum records to return" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("decode_interface_builder"),
    {
      command: CLI_COMMANDS.decodeInterfaceBuilder,
      description:
        "Decode compiled storyboard and nib archives from an app bundle",
      sessionTarget: { description: "Apple .app bundle path" },
      fields: {
        max_documents: { description: "Maximum archives to decode" },
        max_objects: { description: "Maximum graph objects" },
        max_connections: { description: "Maximum decoded connections" },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    run,
  );
};
