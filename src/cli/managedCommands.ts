import { registerContractDocumentCommand } from "./contractDocumentCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { executeManagedMemberComparison } from "../application/managed/ManagedMemberComparisonService.js";
import { executeManagedNativeBoundaries } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../application/managed/ManagedReconstructionService.js";
import { projectManagedApplicationGraphEvidence } from "../application/managed/ManagedApplicationGraphService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../contracts/managed/managedWorkflowToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  runOnEvidenceTargets,
  runOnSessionTarget,
} from "./contractCommand.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { ok } from "../domain/result.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managed/managedToolContracts.js";
import type { JsonValue } from "../domain/jsonValue.js";

export const registerManagedCommands = (
  cli: CliInstance,
  logger: Logger,
  {
    runProviderAnalysis,
    runManagedProviderEvidence,
  }: Pick<DirectAnalysis, "runProviderAnalysis" | "runManagedProviderEvidence">,
): void => {
  registerInspectManagedArtifact(cli, logger, runProviderAnalysis);
  registerInspectManagedMembers(cli, logger, runProviderAnalysis);
  registerInspectManagedNativeBoundaries(cli, logger, runProviderAnalysis);
  registerCompareManagedMembers(cli, logger, runManagedProviderEvidence);
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
      description:
        "Inspect PE/CLI PInvoke and native implementation boundary declarations without loading target code",
      ...managedTarget,
    },
    runOnSessionTarget(runProviderAnalysis, logger),
  );
};

/**
 * Inspect both artifacts as inspect-managed-members would, with the same
 * inspection options, then compare that Evidence.
 */
const registerCompareManagedMembers = (
  cli: CliInstance,
  logger: Logger,
  runManagedProviderEvidence: DirectAnalysis["runManagedProviderEvidence"],
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(MANAGED_WORKFLOW_TOOL_CONTRACTS, "compare_managed_members"),
    {
      description:
        "Compare managed PE/CLI member inventories by exact declared type, name, and signature; names alone never form a match",
      evidenceTargets: {
        fields: {
          left: {
            name: "leftPath",
            description: "Baseline managed PE executable or assembly",
          },
          right: {
            name: "rightPath",
            description: "Candidate managed PE executable or assembly",
          },
        },
        source: {
          contract: contractNamed(
            MANAGED_TOOL_CONTRACTS,
            "inspect_managed_members",
          ),
          fields: {
            type_names: {
              name: "type",
              description:
                "Compare only members declared by this exact type full name on both sides, as selected by inspect-managed-members --type; use it when a whole-assembly comparison exceeds capacity (repeatable)",
            },
            max_snapshot_bytes: {},
            max_metadata_representation_bytes: {},
          },
        },
      },
    },
    runOnEvidenceTargets(
      (target, parameters, signal) =>
        runManagedProviderEvidence(
          target,
          "inspect_managed_members",
          parameters,
          signal,
        ),
      (input, { evidenceTargets, opening, signal }) => {
        const pathOf = (side: string) =>
          evidenceTargets.targets.find(({ field }) => field === side)!.target;
        const compared = executeManagedMemberComparison(input, undefined, {
          signal,
          selection: {
            leftPath: pathOf("left"),
            rightPath: pathOf("right"),
            inspection: opening as Readonly<Record<string, JsonValue>>,
          },
        });
        return Promise.resolve(
          compared.ok ? ok(compared.value.evidence) : compared,
        );
      },
    ),
  );
};

/** Managed Evidence workflows, each taking its contract input as one JSON document. */
const MANAGED_WORKFLOWS = [
  {
    name: "import_managed_reconstruction",
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
  for (const { name, description, document, workflow } of MANAGED_WORKFLOWS)
    registerContractDocumentCommand(
      cli,
      logger,
      contractNamed(MANAGED_WORKFLOW_TOOL_CONTRACTS, name),
      {
        description,
        document,
        cliOptions: { evidenceBundle: evidenceBundleOption },
      },
      (input, { signal, operation, frame, cliOptions }) =>
        runEvidenceInputCommand(
          input,
          { operation, signal, frame, cliOptions },
          (lookup) => Promise.resolve(workflow(input, lookup, signal)),
        ).then(projectCliAnalysisResult),
    );
};
