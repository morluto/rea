import { z } from "incur";

import { compareManagedMemberPaths } from "../application/managed/ManagedMemberComparisonService.js";
import { executeManagedNativeBoundaries } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../application/managed/ManagedReconstructionService.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { MANAGED_STATIC_PROVIDER } from "../domain/investigationProviders.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { registerProjectManagedApplicationGraph } from "./managedProjectGraphCommand.js";
import { managedMembersInputSchema } from "../contracts/managed/managedToolContracts.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

export const registerManagedCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerInspectManagedArtifact(cli, logger, runProviderAnalysis);
  registerInspectManagedMembers(cli, logger, runProviderAnalysis);
  registerInspectManagedNativeBoundaries(cli, logger, runProviderAnalysis);
  registerCompareManagedMembers(cli, logger);
  registerImportManagedReconstruction(cli, logger);
  registerVerifyManagedNativeBoundaries(cli, logger);
  registerProjectManagedApplicationGraph(cli, logger);
};

const registerInspectManagedArtifact = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.inspectManagedArtifact, {
    description: "Inspect PE/CLI identity without loading target code",
    args: z.object({
      path: z.string().describe("Managed PE executable or assembly path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "inspect-managed-artifact", () =>
        runProviderAnalysis(args.path, "inspect_managed_artifact", {}, logger),
      ),
  });
};

const registerInspectManagedMembers = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.inspectManagedMembers, {
    description:
      "Inspect PE/CLI metadata members, signatures, CIL anchors, and ldstr string literals without loading target code",
    args: z.object({
      path: z.string().describe("Managed PE executable or assembly path"),
    }),
    options: z.object({
      type: managedMembersInputSchema.shape.type_names.describe(
        "Inspect only members declared by this exact type full name, and the string literals they load, such as System.Threading.Monitor; a nested type is named by its bare name, which selects every nested type of that name (repeatable)",
      ),
      detail: managedMembersInputSchema.shape.detail.describe(
        "complete returns full Evidence (default); summary returns identity, selection, coverage, limitations and collection counts and requires --evidence-bundle",
      ),
      evidenceBundle: localPathStringSchema
        .optional()
        .describe(
          "Write complete parent Evidence to a new local bundle for later inspect-analysis-view calls; never replaces an existing path",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "inspect-managed-members", () =>
          runProviderAnalysis(
            args.path,
            "inspect_managed_members",
            options.type === undefined ? {} : { type_names: options.type },
            logger,
            signal,
            {
              ...(options.detail === undefined
                ? {}
                : { detail: options.detail }),
              ...(options.evidenceBundle === undefined
                ? {}
                : { evidenceBundlePath: options.evidenceBundle }),
            },
          ),
        ),
      ),
  });
};

const registerInspectManagedNativeBoundaries = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.inspectManagedNativeBoundaries, {
    description:
      "Inspect PE/CLI PInvoke and native implementation boundary declarations without loading target code",
    args: z.object({
      path: z.string().describe("Managed PE executable or assembly path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "inspect-managed-native-boundaries", () =>
        runProviderAnalysis(
          args.path,
          "inspect_managed_native_boundaries",
          {},
          logger,
        ),
      ),
  });
};

const compareManagedMemberArgs = z.object({
  leftPath: z.string().describe("Baseline managed PE executable or assembly"),
  rightPath: z.string().describe("Candidate managed PE executable or assembly"),
});

const registerCompareManagedMembers = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.compareManagedMembers, {
    description:
      "Compare managed PE/CLI member inventories by exact declared type, name, and signature; names alone never form a match",
    args: compareManagedMemberArgs,
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "compare-managed-members", async () => {
          const resources = new ArtifactResourceScope();
          const result = await finishAnalysisCommand(
            () =>
              compareManagedMemberPaths(
                {
                  leftPath: args.leftPath,
                  rightPath: args.rightPath,
                },
                {},
                resources,
              ),
            resources,
            MANAGED_STATIC_PROVIDER.id,
            "compare_managed_members",
            signal,
            "Managed member comparison resources",
          );
          return "evidence_id" in result
            ? result
            : { error: "Managed member comparison failed", ...result };
        }),
      ),
  });
};

const registerImportManagedReconstruction = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.importManagedReconstruction, {
    description:
      "Import decompiler-produced managed reconstruction against exact static member evidence",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline managed reconstruction JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "import-managed-reconstruction", async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "import-managed-reconstruction",
        );
        if (!input.ok) return input.error;
        const result = importManagedReconstructionEvidence(input.value);
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};

const registerVerifyManagedNativeBoundaries = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.verifyManagedNativeBoundaries, {
    description:
      "Verify managed P/Invoke declarations against authenticated native Evidence",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline managed/native verification JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "verify-managed-native-boundaries", async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "verify-managed-native-boundaries",
        );
        if (!input.ok) return input.error;
        const result = executeManagedNativeBoundaries(input.value);
        return result.ok
          ? result.value.evidence
          : projectAnalysisError(result.error);
      }),
  });
};
