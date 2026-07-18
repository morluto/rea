import { Cli, z } from "incur";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./application/Doctor.js";
import {
  runDirectAnalysis,
  runProviderAnalysis,
  runSessionStatus,
} from "./application/DirectAnalysis.js";
import { compareManagedMemberPaths } from "./application/ManagedMemberComparisonService.js";
import { projectManagedApplicationGraphEvidence } from "./application/ManagedApplicationGraphService.js";
import { verifyManagedNativeBoundariesEvidence } from "./application/ManagedNativeVerificationService.js";
import { importManagedReconstructionEvidence } from "./application/ManagedReconstructionService.js";
import { planManagedRuntimeCorrelationEvidence } from "./application/ManagedRuntimeCorrelationService.js";
import { runSetup, systemSetupHost } from "./application/Setup.js";
import { runUninstall } from "./application/Uninstall.js";
import { runUpgrade, systemUpgradeHost } from "./application/Upgrade.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { createLogger, parseLogLevel, type Logger } from "./logger.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { importReferenceSource } from "./application/ReferenceSourceImport.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";
import { registerProcessCommands } from "./cliProcessCommands.js";
import { registerInvestigationCommands } from "./cliInvestigationCommands.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
  projectAnalysisError,
} from "./domain/errors.js";
import { projectReferenceSourceImportError } from "./application/ReferenceSourceImportTypes.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { registerPolicyCommands } from "./cliPolicyCommands.js";
import { registerBrowserCommands } from "./cliBrowserCommands.js";
import { registerAdvancedBrowserCommands } from "./cliBrowserAdvancedCommands.js";
import { registerElectronCommands } from "./cliElectronCommands.js";
import { registerApplicationCommands } from "./cliApplicationCommands.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import {
  analysisProviderSelectorSchema,
  type AnalysisProviderSelector,
} from "./contracts/providerSelection.js";
import { createSystemDoctorHost } from "./doctorRuntime.js";
import {
  conciseSetupResult,
  confirmInteractiveSetup,
  renderInteractiveSetupResult,
  renderSetupProgress,
} from "./cliSetup.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (): ReturnType<typeof Cli.create> => {
  const logger = createLogger(
    "cli",
    process.env.REA_LOG_LEVEL === undefined
      ? "silent"
      : parseLogLevel(process.env.REA_LOG_LEVEL),
  );
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    mcp: {
      command: PRODUCT_IDENTITY.mcpCommand,
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      include: ["skills/*"],
      suggestions: [
        "understand how a software feature works",
        "investigate an artifact or observed behavior",
        "check my REA setup",
      ],
    },
  });

  registerSetupCommands(cli, logger);
  registerCoreCommands(cli, logger);
  registerFunctionCommand(cli, logger);
  registerSearchCommand(cli, logger);
  registerXrefsCommand(cli, logger);
  registerTraceCommand(cli, logger);
  registerCapabilityCommands(cli, logger);
  registerNativeCommands(cli, logger);
  registerArtifactCommands(cli, logger);
  registerManagedCommands(cli, logger);
  registerInvestigationCommands(cli, logger);
  registerEvidenceCommands(cli, logger);
  registerReferenceSourceCommand(cli, logger);
  registerProcessCommands(cli, logger);
  registerPolicyCommands(cli, logger);
  registerBrowserCommands(cli, logger);
  registerAdvancedBrowserCommands(cli, logger);
  registerElectronCommands(cli, logger);
  registerApplicationCommands(cli, logger);
  return cli;
};

const registerCoreCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const overviewOptions = z.object({
    detail: z
      .enum(["concise", "detailed"])
      .default("concise")
      .describe("Overview detail level"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum overview items to return"),
    snapshot: z
      .string()
      .min(1)
      .optional()
      .describe("Load and update a local analysis snapshot"),
    provider: providerSelectionOption,
  });
  cli.command(CLI_COMMANDS.analyze, {
    description: "Get an overview of an app",
    args: z.object({
      path: z.string().describe("App, program, or analysis database path"),
    }),
    options: overviewOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "analyze", () =>
        runDirectAnalysis(
          args.path,
          "binary_overview",
          { detail: options.detail, limit: options.limit },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.inspect, {
    description: "Inspect an app overview with evidence",
    args: z.object({
      path: z.string().describe("App, program, or analysis database path"),
    }),
    options: overviewOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect", () =>
        runDirectAnalysis(
          args.path,
          "binary_overview",
          { detail: options.detail, limit: options.limit },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.decompile, {
    description: "Read one part of an app as code",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure address"),
    }),
    options: z.object({
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "decompile", () =>
        runDirectAnalysis(
          args.path,
          "procedure_pseudo_code",
          { procedure: args.address },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
};

const registerSetupCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.setup, {
    description: "Install requirements and configure agents",
    outputPolicy: "agent-only",
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve user-owned setup actions without prompting"),
      installHopper: z
        .boolean()
        .default(false)
        .describe("Also approve Hopper installation with --yes"),
      client: z
        .array(
          z.enum([
            "claude_code",
            "claude_desktop",
            "codex",
            "cursor",
            "gemini_cli",
            "windsurf",
          ]),
        )
        .default([])
        .describe("Agent integration to configure; repeat for multiple agents"),
      allDetected: z
        .boolean()
        .default(false)
        .describe("Configure every detected supported agent"),
      skill: z
        .boolean()
        .optional()
        .describe("Install or skip the bundled REA skill"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Print the resolved plan without applying it"),
      accessible: z
        .boolean()
        .default(false)
        .describe("Use sequential accessible setup prompts"),
    }),
    alias: {
      yes: "y",
    },
    run: ({ options, formatExplicit, agent }) =>
      logCliCommand(logger, "setup", () =>
        runSetupCommand({ options, formatExplicit, agent }),
      ),
  });
  cli.command(CLI_COMMANDS.doctor, {
    description: "Check whether REA is ready",
    options: z.object({
      target: z.string().optional().describe("Optional app path to check"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, "doctor", () =>
        runDoctor(options.target, createSystemDoctorHost()),
      ),
  });
  cli.command(CLI_COMMANDS.uninstall, {
    description: "Remove REA-owned agent configuration and skill files",
    options: z.object({
      purgeData: z
        .boolean()
        .default(false)
        .describe("Also remove REA caches and state"),
    }),
    alias: { purgeData: "purge-data" },
    run: ({ options }) =>
      logCliCommand(logger, "uninstall", () => runUninstall(options.purgeData)),
  });
  cli.command(CLI_COMMANDS.upgrade, {
    description: "Upgrade a global npm installation to the latest REA release",
    run: ({ formatExplicit }) =>
      logCliCommand(logger, "upgrade", () =>
        runUpgrade(
          PRODUCT_IDENTITY.packageVersion,
          systemUpgradeHost(),
          formatExplicit ? "structured" : "human",
        ),
      ),
  });
};

const runSetupCommand = async (input: {
  readonly options: {
    readonly yes: boolean;
    readonly installHopper: boolean;
    readonly client: readonly string[];
    readonly allDetected: boolean;
    readonly skill?: boolean | undefined;
    readonly dryRun: boolean;
    readonly accessible: boolean;
  };
  readonly formatExplicit: boolean;
  readonly agent: boolean;
}) => {
  const { options } = input;
  const interactive =
    !options.yes &&
    !options.dryRun &&
    !input.formatExplicit &&
    process.stdin.isTTY === true &&
    process.stderr.isTTY === true;
  const hasExplicitScope =
    options.allDetected ||
    options.client.length > 0 ||
    options.skill !== undefined ||
    options.installHopper;
  if (options.yes && !hasExplicitScope)
    process.stderr.write(
      "!  Implicit `rea setup --yes` scope is deprecated; use `--all-detected --skill` to retain it.\n",
    );
  const result = await runSetup(
    {
      approved: options.yes && !options.dryRun,
      installHopper: options.installHopper,
      structured: input.formatExplicit || options.dryRun,
      proposeHopper: !hasExplicitScope || options.installHopper,
      ...(!hasExplicitScope || options.allDetected
        ? {}
        : { clientIds: options.client }),
      ...(!hasExplicitScope ? {} : { installSkill: options.skill ?? false }),
      ...(interactive ? { onProgress: renderSetupProgress } : {}),
    },
    systemSetupHost(createSystemDoctorHost()),
    interactive
      ? (actions) => confirmInteractiveSetup(actions, options.accessible)
      : undefined,
  );
  if (interactive) renderInteractiveSetupResult(result);
  return input.formatExplicit ? result : conciseSetupResult(result);
};

const registerXrefsCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.xrefs, {
    description: "List bounded references to an analyzed address",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Hexadecimal address"),
    }),
    options: z.object({
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "xrefs", () =>
        runDirectAnalysis(
          args.path,
          "xrefs",
          { address: args.address },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
};

const registerTraceCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.trace, {
    description: "Trace a bounded literal feature through analyzed references",
    args: z.object({
      path: z.string().describe("App or program path"),
      query: z.string().min(1).describe("Literal feature query"),
    }),
    options: z.object({
      caseSensitive: z
        .boolean()
        .default(false)
        .describe("Match the query with exact letter case"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum matching roots to examine"),
      maxOperations: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum analysis operations in the trace"),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      provider: providerSelectionOption,
    }),
    alias: {
      caseSensitive: "case-sensitive",
      maxOperations: "max-operations",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "trace", () =>
        runDirectAnalysis(
          args.path,
          "trace_feature",
          {
            query: args.query,
            case_sensitive: options.caseSensitive,
            limit: options.limit,
            max_operations: options.maxOperations,
          },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
};

const registerCapabilityCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  for (const command of [
    CLI_COMMANDS.capabilities,
    CLI_COMMANDS.providers,
  ] as const) {
    cli.command(command, {
      description:
        command === "capabilities"
          ? "List provider capabilities and side effects"
          : "List configured analysis providers",
      run: () => logCliCommand(logger, command, () => runSessionStatus(logger)),
    });
  }
};

const registerFunctionCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.function, {
    description: "Analyze one bounded function with evidence",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure name or address"),
    }),
    options: z.object({
      includeAssembly: z
        .boolean()
        .default(false)
        .describe("Include bounded assembly instructions"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum referenced items to return"),
      maxPseudocodeChars: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(20_000)
        .describe("Maximum pseudocode characters to return"),
      maxInstructions: z
        .number()
        .int()
        .min(1)
        .max(5_000)
        .default(500)
        .describe("Maximum assembly instructions to return"),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      provider: providerSelectionOption,
    }),
    alias: {
      includeAssembly: "include-assembly",
      maxPseudocodeChars: "max-pseudocode-chars",
      maxInstructions: "max-instructions",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "function", () =>
        runDirectAnalysis(
          args.path,
          "analyze_function",
          {
            procedure: args.address,
            include_assembly: options.includeAssembly,
            limit: options.limit,
            max_pseudocode_chars: options.maxPseudocodeChars,
            max_instructions: options.maxInstructions,
          },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
};

const registerSearchCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.search, {
    description: "Search bounded analyzed strings or procedure names",
    args: z.object({
      path: z.string().describe("App or program path"),
      pattern: z.string().min(1).describe("Literal text or regex pattern"),
    }),
    options: z.object({
      kind: z
        .enum(["strings", "procedures"])
        .default("strings")
        .describe("Analyzed item kind to search"),
      mode: z
        .enum(["literal", "regex"])
        .default("literal")
        .describe("Interpret the pattern as literal text or a regex"),
      caseSensitive: z
        .boolean()
        .default(false)
        .describe("Match the pattern with exact letter case"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based matching-item offset"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(100)
        .describe("Maximum matching items to return"),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      provider: providerSelectionOption,
    }),
    alias: { caseSensitive: "case-sensitive" },
    run: ({ args, options }) =>
      logCliCommand(logger, "search", () =>
        runDirectAnalysis(
          args.path,
          options.kind === "strings" ? "search_strings" : "search_procedures",
          {
            pattern: args.pattern,
            mode: options.mode,
            case_sensitive: options.caseSensitive,
            offset: options.offset,
            limit: options.limit,
          },
          directAnalysisOptions(logger, options.snapshot, options.provider),
        ),
      ),
  });
};

const registerReferenceSourceCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.importReferenceSource, {
    description: "Import a bounded source tree as historical reference only",
    args: z.object({
      root: z
        .string()
        .describe("Source root allowed by REA_REFERENCE_ROOTS_JSON"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "import-reference-source", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return {
            error: "Import failed",
            ...projectAnalysisError(config.error),
          };
        const authority = await loadConfiguredPermissionAuthority(config.value);
        if (!authority.ok)
          return {
            error: "Import failed",
            ...projectAnalysisError(authority.error),
          };
        const authorized = await authority.value.authorize(
          {
            capability: "reference_read",
            roots: [args.root],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `import_reference_source:${args.root}`,
          },
          "read",
        );
        if (!authorized.ok) {
          const error =
            authorized.error instanceof PermissionRequiredError
              ? authorized.error
              : new AnalysisProtocolError(authorized.error.message, {
                  cause: authorized.error,
                });
          return {
            error: "Import failed",
            ...projectAnalysisError(error),
          };
        }
        const imported = await importReferenceSource({
          root: args.root,
          caller: "rea-cli",
          policy: config.value.referenceSourcePolicy,
          importer: PRODUCT_IDENTITY.packageName,
          importerVersion: null,
        });
        return imported.ok
          ? imported.value
          : {
              error: "Import failed",
              ...projectReferenceSourceImportError(imported.error),
            };
      }),
  });
};

const registerArtifactCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inventoryArtifact, {
    description: "Build a bounded deterministic artifact graph",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based offset for graph nodes, occurrences, and edges"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum nodes, occurrences, and edges per result section"),
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
      integrityContinueApproved: z
        .boolean()
        .default(false)
        .describe("Approve continuing after recorded integrity mismatches"),
      maxIntegrityMismatches: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum integrity mismatches to record before stopping"),
      nativeMountApproved: z
        .boolean()
        .default(false)
        .describe("Approve read-only native mounting when required"),
    }),
    alias: {
      integrityPolicy: "integrity-policy",
      integrityContinueApproved: "integrity-continue-approved",
      maxIntegrityMismatches: "max-integrity-mismatches",
      nativeMountApproved: "native-mount-approved",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inventory-artifact", () =>
        runProviderAnalysis(
          args.path,
          "inventory_artifact",
          {
            node_offset: options.offset,
            node_limit: options.limit,
            occurrence_offset: options.offset,
            occurrence_limit: options.limit,
            edge_offset: options.offset,
            edge_limit: options.limit,
            integrity_policy: options.integrityPolicy,
            integrity_continue_approved: options.integrityContinueApproved,
            max_integrity_mismatches: options.maxIntegrityMismatches,
            native_mount_approved: options.nativeMountApproved,
          },
          logger,
        ),
      ),
  });
  cli.command(CLI_COMMANDS.extractArtifact, {
    description: "Extract explicitly selected artifact occurrences safely",
    args: z.object({
      path: z.string().describe("Application or package path"),
      outputRoot: z.string().describe("Absent absolute output root"),
      occurrenceIds: z
        .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
        .min(1)
        .max(500)
        .describe("Exact artifact occurrence IDs selected for extraction"),
    }),
    alias: { outputRoot: "output-root", occurrenceIds: "occurrence-ids" },
    run: ({ args }) =>
      logCliCommand(logger, "extract-artifact", () =>
        runProviderAnalysis(
          args.path,
          "extract_artifact",
          {
            approved: true,
            output_root: args.outputRoot,
            occurrence_ids: args.occurrenceIds,
          },
          logger,
        ),
      ),
  });
};

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

const registerManagedCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectManagedArtifact, {
    description: "Inspect PE/CLI identity without loading target code",
    args: z.object({
      path: z.string().describe("Managed PE executable or assembly path"),
    }),
    options: z.object({
      referenceOffset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based assembly-reference offset"),
      referenceLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum assembly references to return"),
      resourceOffset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based manifest-resource offset"),
      resourceLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum manifest resources to return"),
      attributeOffset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based assembly-attribute offset"),
      attributeLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum assembly attributes to return"),
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
  cli.command(CLI_COMMANDS.compareManagedMembers, {
    description:
      "Compare two managed PE/CLI member inventories without name-based matching",
    args: z.object({
      leftPath: z
        .string()
        .describe("Baseline managed PE executable or assembly"),
      rightPath: z
        .string()
        .describe("Candidate managed PE executable or assembly"),
    }),
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
          memberLimits: {
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
          },
        });
        return result.ok
          ? result.value
          : {
              error: "Managed member comparison failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
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
  cli.command(CLI_COMMANDS.projectManagedApplicationGraph, {
    description:
      "Project authenticated managed static Evidence into an application graph",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline managed application graph JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "project-managed-application-graph", async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "project-managed-application-graph",
        );
        if (!input.ok) return input.error;
        const result = projectManagedApplicationGraphEvidence(input.value);
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};

const registerNativeCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  for (const [command, tool] of [
    [CLI_COMMANDS.inspectMacho, "inspect_macho"],
    [CLI_COMMANDS.inspectSignature, "inspect_signature"],
    [CLI_COMMANDS.listArchitectures, "list_architectures"],
  ] as const) {
    cli.command(command, {
      description: `Run ${tool} without launching Hopper`,
      args: z.object({ path: z.string().describe("Mach-O or app path") }),
      run: ({ args }) =>
        logCliCommand(logger, command, () =>
          runProviderAnalysis(args.path, tool, {}, logger),
        ),
    });
  }
  cli.command(CLI_COMMANDS.inspectPlist, {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({ path: z.string().describe("App or Mach-O path") }),
    options: z.object({
      relativePath: z
        .string()
        .default("Contents/Info.plist")
        .describe("Plist path relative to the app root"),
    }),
    alias: { relativePath: "relative-path" },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-plist", () =>
        runProviderAnalysis(
          args.path,
          "inspect_plist",
          { relative_path: options.relativePath },
          logger,
        ),
      ),
  });
  cli.command(CLI_COMMANDS.demangleSwift, {
    description: "Demangle a bounded Swift symbol batch without Hopper",
    args: z.object({
      path: z.string().describe("Artifact path used for evidence identity"),
      symbols: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .describe("Swift mangled symbols to demangle"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "demangle-swift", () =>
        runProviderAnalysis(
          args.path,
          "demangle_swift",
          { symbols: args.symbols },
          logger,
        ),
      ),
  });
};

const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
) => ({
  logger,
  snapshotPath,
  ...(providerId === undefined ? {} : { providerId }),
});
