import { z } from "incur";

import {
  compareManagedMemberPaths,
  type ManagedMemberPathInspectionLimits,
} from "../application/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesEvidence } from "../application/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "../application/ManagedReconstructionService.js";
import { planManagedRuntimeCorrelationEvidence } from "../application/ManagedRuntimeCorrelationService.js";
import { runProviderAnalysis } from "../application/DirectAnalysis.js";
import { parseConfig } from "../config.js";
import { loadConfiguredPermissionAuthority } from "../application/PermissionConfiguration.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/errors.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { registerProjectManagedApplicationGraph } from "./managedProjectGraphCommand.js";

const managedOffset = (subject: string) =>
  z.number().int().min(0).default(0).describe(`Zero-based ${subject} offset`);

const managedLimit = (subject: string, maximum: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(maximum)
    .default(fallback)
    .describe(`Maximum ${subject} to return`);

const managedInspectionLimits = {
  maxFileBytes: z
    .number()
    .int()
    .min(4_096)
    .max(1_073_741_824)
    .default(268_435_456)
    .describe("Maximum managed artifact file size accepted for inspection"),
  maxMetadataBytes: z
    .number()
    .int()
    .min(256)
    .max(268_435_456)
    .default(67_108_864)
    .describe("Maximum CLI metadata region size accepted for inspection"),
  maxTableRows: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100_000)
    .describe("Maximum rows accepted in any CLI metadata table"),
  maxHeapItemBytes: z
    .number()
    .int()
    .min(1)
    .max(16_777_216)
    .default(1_048_576)
    .describe("Maximum bytes accepted for one CLI metadata heap item"),
};

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
  registerPlanManagedRuntimeCorrelation(cli, logger);
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
    options: z.object({
      referenceOffset: managedOffset("assembly-reference"),
      referenceLimit: managedLimit("assembly references", 500, 100),
      resourceOffset: managedOffset("manifest-resource"),
      resourceLimit: managedLimit("manifest resources", 500, 100),
      attributeOffset: managedOffset("assembly-attribute"),
      attributeLimit: managedLimit("assembly attributes", 500, 100),
      ...managedInspectionLimits,
    }),
    alias: {
      referenceOffset: "reference-offset",
      referenceLimit: "reference-limit",
      resourceOffset: "resource-offset",
      resourceLimit: "resource-limit",
      attributeOffset: "attribute-offset",
      attributeLimit: "attribute-limit",
      maxFileBytes: "max-file-bytes",
      maxMetadataBytes: "max-metadata-bytes",
      maxTableRows: "max-table-rows",
      maxHeapItemBytes: "max-heap-item-bytes",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-managed-artifact", () =>
        runProviderAnalysis(
          args.path,
          "inspect_managed_artifact",
          {
            reference_offset: options.referenceOffset,
            reference_limit: options.referenceLimit,
            resource_offset: options.resourceOffset,
            resource_limit: options.resourceLimit,
            attribute_offset: options.attributeOffset,
            attribute_limit: options.attributeLimit,
            max_file_bytes: options.maxFileBytes,
            max_metadata_bytes: options.maxMetadataBytes,
            max_table_rows: options.maxTableRows,
            max_heap_item_bytes: options.maxHeapItemBytes,
          },
          logger,
        ),
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
    options: z.object({
      typeOffset: managedOffset("type definition"),
      typeLimit: managedLimit("type definitions", 500, 100),
      methodOffset: managedOffset("method definition"),
      methodLimit: managedLimit("method definitions", 500, 100),
      fieldOffset: managedOffset("field definition"),
      fieldLimit: managedLimit("field definitions", 500, 100),
      memberRefOffset: managedOffset("member reference"),
      memberRefLimit: managedLimit("member references", 500, 100),
      edgeOffset: managedOffset("member edge"),
      edgeLimit: managedLimit("member edges", 1_000, 250),
      instructionAnchorLimit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(100)
        .describe("Maximum CIL instruction anchors per method"),
      ...managedInspectionLimits,
      maxMethodBodyBytes: z
        .number()
        .int()
        .min(1)
        .max(16_777_216)
        .default(1_048_576)
        .describe("Maximum CIL method body size accepted for inspection"),
      maxMethodInstructions: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(10_000)
        .describe("Maximum decoded CIL instructions per method"),
    }),
    alias: {
      typeOffset: "type-offset",
      typeLimit: "type-limit",
      methodOffset: "method-offset",
      methodLimit: "method-limit",
      fieldOffset: "field-offset",
      fieldLimit: "field-limit",
      memberRefOffset: "member-ref-offset",
      memberRefLimit: "member-ref-limit",
      edgeOffset: "edge-offset",
      edgeLimit: "edge-limit",
      instructionAnchorLimit: "instruction-anchor-limit",
      maxFileBytes: "max-file-bytes",
      maxMetadataBytes: "max-metadata-bytes",
      maxTableRows: "max-table-rows",
      maxHeapItemBytes: "max-heap-item-bytes",
      maxMethodBodyBytes: "max-method-body-bytes",
      maxMethodInstructions: "max-method-instructions",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-managed-members", () =>
        runProviderAnalysis(
          args.path,
          "inspect_managed_members",
          {
            type_offset: options.typeOffset,
            type_limit: options.typeLimit,
            method_offset: options.methodOffset,
            method_limit: options.methodLimit,
            field_offset: options.fieldOffset,
            field_limit: options.fieldLimit,
            member_ref_offset: options.memberRefOffset,
            member_ref_limit: options.memberRefLimit,
            edge_offset: options.edgeOffset,
            edge_limit: options.edgeLimit,
            instruction_anchor_limit: options.instructionAnchorLimit,
            max_file_bytes: options.maxFileBytes,
            max_metadata_bytes: options.maxMetadataBytes,
            max_table_rows: options.maxTableRows,
            max_heap_item_bytes: options.maxHeapItemBytes,
            max_method_body_bytes: options.maxMethodBodyBytes,
            max_method_instructions: options.maxMethodInstructions,
          },
          logger,
        ),
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
    options: z.object({
      moduleRefOffset: managedOffset("module reference"),
      moduleRefLimit: managedLimit("module references", 500, 100),
      importOffset: managedOffset("platform import"),
      importLimit: managedLimit("platform imports", 500, 100),
      implementationOffset: managedOffset("native implementation"),
      implementationLimit: managedLimit("native implementations", 500, 100),
      ...managedInspectionLimits,
    }),
    alias: {
      moduleRefOffset: "module-ref-offset",
      moduleRefLimit: "module-ref-limit",
      importOffset: "import-offset",
      importLimit: "import-limit",
      implementationOffset: "implementation-offset",
      implementationLimit: "implementation-limit",
      maxFileBytes: "max-file-bytes",
      maxMetadataBytes: "max-metadata-bytes",
      maxTableRows: "max-table-rows",
      maxHeapItemBytes: "max-heap-item-bytes",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-managed-native-boundaries", () =>
        runProviderAnalysis(
          args.path,
          "inspect_managed_native_boundaries",
          {
            module_ref_offset: options.moduleRefOffset,
            module_ref_limit: options.moduleRefLimit,
            import_offset: options.importOffset,
            import_limit: options.importLimit,
            implementation_offset: options.implementationOffset,
            implementation_limit: options.implementationLimit,
            max_file_bytes: options.maxFileBytes,
            max_metadata_bytes: options.maxMetadataBytes,
            max_table_rows: options.maxTableRows,
            max_heap_item_bytes: options.maxHeapItemBytes,
          },
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
      "Compare two managed PE/CLI member inventories without name-based matching",
    args: compareManagedMemberArgs,
    options: z.object({
      maxMethodMatches: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .default(10_000)
        .describe("Maximum exact method matches to return"),
      maxFieldMatches: z
        .number()
        .int()
        .min(0)
        .max(50_000)
        .default(5_000)
        .describe("Maximum exact field matches to return"),
      maxCandidates: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum ambiguous candidates per unmatched member"),
      typeLimit: managedLimit("type definitions per artifact", 500, 500),
      methodLimit: managedLimit("method definitions per artifact", 500, 500),
      fieldLimit: managedLimit("field definitions per artifact", 500, 500),
      memberRefLimit: managedLimit("member references per artifact", 500, 500),
      edgeLimit: managedLimit("member edges per artifact", 1_000, 1_000),
      instructionAnchorLimit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(500)
        .describe("Maximum CIL instruction anchors per compared method"),
      ...managedInspectionLimits,
      maxMethodBodyBytes: z
        .number()
        .int()
        .min(1)
        .max(16_777_216)
        .default(1_048_576)
        .describe("Maximum CIL method body size accepted for comparison"),
      maxMethodInstructions: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(100_000)
        .describe("Maximum decoded CIL instructions per compared method"),
    }),
    alias: {
      maxMethodMatches: "max-method-matches",
      maxFieldMatches: "max-field-matches",
      maxCandidates: "max-candidates",
      typeLimit: "type-limit",
      methodLimit: "method-limit",
      fieldLimit: "field-limit",
      memberRefLimit: "member-ref-limit",
      edgeLimit: "edge-limit",
      instructionAnchorLimit: "instruction-anchor-limit",
      maxFileBytes: "max-file-bytes",
      maxMetadataBytes: "max-metadata-bytes",
      maxTableRows: "max-table-rows",
      maxHeapItemBytes: "max-heap-item-bytes",
      maxMethodBodyBytes: "max-method-body-bytes",
      maxMethodInstructions: "max-method-instructions",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "compare-managed-members", async () => {
        const result = await compareManagedMemberPaths({
          leftPath: args.leftPath,
          rightPath: args.rightPath,
          comparisonLimits: {
            max_method_matches: options.maxMethodMatches,
            max_field_matches: options.maxFieldMatches,
            max_candidates: options.maxCandidates,
          },
          memberLimits: buildMemberLimits(options),
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

interface ManagedMemberLimitOptions {
  readonly maxFileBytes: number;
  readonly typeLimit: number;
  readonly methodLimit: number;
  readonly fieldLimit: number;
  readonly memberRefLimit: number;
  readonly edgeLimit: number;
  readonly instructionAnchorLimit: number;
  readonly maxMetadataBytes: number;
  readonly maxTableRows: number;
  readonly maxHeapItemBytes: number;
  readonly maxMethodBodyBytes: number;
  readonly maxMethodInstructions: number;
}

const buildMemberLimits = (
  options: ManagedMemberLimitOptions,
): ManagedMemberPathInspectionLimits => ({
  maxFileBytes: options.maxFileBytes,
  typeOffset: 0,
  typeLimit: options.typeLimit,
  methodOffset: 0,
  methodLimit: options.methodLimit,
  fieldOffset: 0,
  fieldLimit: options.fieldLimit,
  memberRefOffset: 0,
  memberRefLimit: options.memberRefLimit,
  edgeOffset: 0,
  edgeLimit: options.edgeLimit,
  instructionAnchorLimit: options.instructionAnchorLimit,
  maxMetadataBytes: options.maxMetadataBytes,
  maxTableRows: options.maxTableRows,
  maxHeapItemBytes: options.maxHeapItemBytes,
  maxMethodBodyBytes: options.maxMethodBodyBytes,
  maxMethodInstructions: options.maxMethodInstructions,
});

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

const registerPlanManagedRuntimeCorrelation = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.planManagedRuntimeCorrelation, {
    description:
      "Plan a separately authorized managed runtime-correlation experiment without executing target code",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline managed runtime-correlation JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "plan-managed-runtime-correlation", async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "plan-managed-runtime-correlation",
        );
        if (!input.ok) return input.error;
        const config = parseConfig(process.env);
        if (!config.ok) return projectAnalysisError(config.error);
        const authority = await loadConfiguredPermissionAuthority(config.value);
        if (!authority.ok) return projectAnalysisError(authority.error);
        const result = await planManagedRuntimeCorrelationEvidence(
          {
            policy: config.value.managedRuntimePolicy,
            authority: authority.value,
          },
          input.value,
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};
