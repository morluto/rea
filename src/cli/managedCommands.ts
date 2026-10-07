import { z } from "incur";

import { compareManagedMemberPaths } from "../application/managed/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesEvidence } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../application/managed/ManagedReconstructionService.js";
import { runProviderAnalysis } from "../composition/directAnalysis.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { registerProjectManagedApplicationGraph } from "./managedProjectGraphCommand.js";

export const registerManagedCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerInspectManagedArtifact(cli, logger);
  registerInspectManagedMembers(cli, logger);
  registerInspectManagedNativeBoundaries(cli, logger);
  registerCompareManagedMembers(cli, logger);
  registerImportManagedReconstruction(cli, logger);
  registerVerifyManagedNativeBoundaries(cli, logger);
  registerProjectManagedApplicationGraph(cli, logger);
};

const registerInspectManagedArtifact = (
  cli: CliInstance,
  logger: Logger,
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
): void => {
  cli.command(CLI_COMMANDS.inspectManagedMembers, {
    description:
      "Inspect PE/CLI metadata members, signatures, and CIL anchors without loading target code",
    args: z.object({
      path: z.string().describe("Managed PE executable or assembly path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "inspect-managed-members", () =>
        runProviderAnalysis(args.path, "inspect_managed_members", {}, logger),
      ),
  });
};

const registerInspectManagedNativeBoundaries = (
  cli: CliInstance,
  logger: Logger,
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
      logCliCommand(logger, "compare-managed-members", async () => {
        const result = await compareManagedMemberPaths({
          leftPath: args.leftPath,
          rightPath: args.rightPath,
        });
        return result.ok
          ? result.value
          : {
              error: "Managed member comparison failed",
              ...projectAnalysisError(result.error),
            };
      }),
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
        const result = verifyManagedNativeBoundariesEvidence(input.value);
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};
