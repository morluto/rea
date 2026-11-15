import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";

import { compareManagedMemberPaths } from "../application/managed/ManagedMemberComparisonService.js";
import { executeManagedNativeBoundaries } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../application/managed/ManagedReconstructionService.js";
import { projectManagedApplicationGraphEvidence } from "../application/managed/ManagedApplicationGraphService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../contracts/managed/managedWorkflowToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  registerContractDocumentCommand,
  runOnSessionTarget,
} from "./contractCommand.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { MANAGED_STATIC_PROVIDER } from "../domain/investigationProviders.js";
import { ok } from "../domain/result.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import {
  MANAGED_TOOL_CONTRACTS,
  managedMembersInputSchema,
} from "../contracts/managed/managedToolContracts.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { managedInspectionBudgetShape } from "../domain/managed/managedInspectionLimits.js";
import { cliDecimalField } from "./options.js";

const managedBudgetOptions = {
  maxSnapshotBytes: cliDecimalField(
    managedInspectionBudgetShape.max_snapshot_bytes,
  ),
  maxMetadataRepresentationBytes: cliDecimalField(
    managedInspectionBudgetShape.max_metadata_representation_bytes,
  ),
};

export const registerManagedCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerInspectManagedArtifact(cli, logger, runProviderAnalysis);
  registerInspectManagedMembers(cli, logger, runProviderAnalysis);
  registerInspectManagedNativeBoundaries(cli, logger, runProviderAnalysis);
  registerCompareManagedMembers(cli, logger);
  registerManagedWorkflowCommands(cli, logger);
};

/** The one-shot CLI opens its target; MCP may reuse a selected one. */
const managedTarget = {
  sessionTarget: { description: "Managed PE executable or assembly path" },
  omit: { path: "The CLI selects the managed target as its first argument" },
} as const;

const registerInspectManagedArtifact = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(MANAGED_TOOL_CONTRACTS, "inspect_managed_artifact"),
    {
      command: CLI_COMMANDS.inspectManagedArtifact,
      description: "Inspect PE/CLI identity without loading target code",
      ...managedTarget,
      evidenceDelivery: true,
    },
    runOnSessionTarget(runProviderAnalysis, logger),
  );
};

const registerInspectManagedMembers = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(MANAGED_TOOL_CONTRACTS, "inspect_managed_members"),
    {
      command: CLI_COMMANDS.inspectManagedMembers,
      description:
        "Inspect PE/CLI metadata members, signatures, CIL anchors, and ldstr string literals without loading target code",
      ...managedTarget,
      evidenceDelivery: true,
      fields: {
        type_names: {
          name: "type",
          description:
            "Inspect only members declared by this exact type full name, and the string literals they load, such as System.Threading.Monitor; a nested type is named by its bare name, which selects every nested type of that name (repeatable)",
        },
      },
    },
    runOnSessionTarget(runProviderAnalysis, logger),
  );
};

const registerInspectManagedNativeBoundaries = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(MANAGED_TOOL_CONTRACTS, "inspect_managed_native_boundaries"),
    {
      command: CLI_COMMANDS.inspectManagedNativeBoundaries,
      description:
        "Inspect PE/CLI PInvoke and native implementation boundary declarations without loading target code",
      ...managedTarget,
    },
    runOnSessionTarget(runProviderAnalysis, logger),
  );
};

const compareManagedMemberArgs = z.object({
  leftPath: localPathStringSchema.describe(
    "Baseline managed PE executable or assembly",
  ),
  rightPath: localPathStringSchema.describe(
    "Candidate managed PE executable or assembly",
  ),
});

const registerCompareManagedMembers = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.compareManagedMembers, {
    description:
      "Compare managed PE/CLI member inventories by exact declared type, name, and signature; names alone never form a match",
    args: compareManagedMemberArgs,
    options: z.object({
      ...managedBudgetOptions,
      type: managedMembersInputSchema.shape.type_names.describe(
        "Compare only members declared by this exact type full name on both sides, as selected by inspect-managed-members --type; use it when a whole-assembly comparison exceeds capacity (repeatable)",
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "compare-managed-members", async () => {
          const resources = new ArtifactResourceScope();
          const result = await finishAnalysisCommand(
            () =>
              compareManagedMemberPaths(
                {
                  leftPath: args.leftPath,
                  rightPath: args.rightPath,
                  ...(options.maxSnapshotBytes === undefined
                    ? {}
                    : { maxSnapshotBytes: options.maxSnapshotBytes }),
                  ...(options.maxMetadataRepresentationBytes === undefined
                    ? {}
                    : {
                        maxRepresentationBytes:
                          options.maxMetadataRepresentationBytes,
                      }),
                  ...(options.type === undefined
                    ? {}
                    : { typeNames: options.type }),
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
          return result.ok
            ? result.value
            : { error: "Managed member comparison failed", ...result.error };
        }),
      ),
  });
};

/** Managed Evidence workflows, each taking its contract input as one JSON document. */
const MANAGED_WORKFLOWS = [
  {
    name: "import_managed_reconstruction",
    command: CLI_COMMANDS.importManagedReconstruction,
    description:
      "Import decompiler-produced managed reconstruction against exact static member evidence",
    document: "Inline managed reconstruction JSON or JSON file path",
    workflow: (
      input: unknown,
      lookup: EvidenceLookup | undefined,
      signal: AbortSignal,
    ) => importManagedReconstructionEvidence(input, lookup, { signal }),
  },
  {
    name: "verify_managed_native_boundaries",
    command: CLI_COMMANDS.verifyManagedNativeBoundaries,
    description:
      "Verify managed P/Invoke declarations against authenticated native Evidence",
    document: "Inline managed/native verification JSON or JSON file path",
    workflow: (
      input: unknown,
      lookup: EvidenceLookup | undefined,
      signal: AbortSignal,
    ) => {
      const result = executeManagedNativeBoundaries(input, lookup, { signal });
      return result.ok ? ok(result.value.evidence) : result;
    },
  },
  {
    name: "project_managed_application_graph",
    command: CLI_COMMANDS.projectManagedApplicationGraph,
    description:
      "Project authenticated managed static Evidence into an application graph",
    document: "Inline managed application graph JSON or JSON file path",
    workflow: (
      input: unknown,
      lookup: EvidenceLookup | undefined,
      signal: AbortSignal,
    ) => projectManagedApplicationGraphEvidence(input, lookup, { signal }),
  },
] as const;

const registerManagedWorkflowCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  for (const {
    name,
    command,
    description,
    document,
    workflow,
  } of MANAGED_WORKFLOWS)
    registerContractDocumentCommand(
      cli,
      logger,
      contractNamed(MANAGED_WORKFLOW_TOOL_CONTRACTS, name),
      {
        command,
        description,
        document,
        cliOptions: { evidenceBundle: evidenceBundleOption },
      },
      (input, { signal, operation, cliOptions }) =>
        runEvidenceInputCommand(
          operation,
          cliOptions.evidenceBundle,
          signal,
          (lookup) => Promise.resolve(workflow(input, lookup, signal)),
        ).then(projectCliAnalysisResult),
    );
};
