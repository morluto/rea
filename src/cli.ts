import { Cli, z } from "incur";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./application/Doctor.js";
import {
  runDirectAnalysis,
  runProviderAnalysis,
  runSessionStatus,
} from "./application/DirectAnalysis.js";
import { runSetup } from "./application/Setup.js";
import { runUninstall } from "./application/Uninstall.js";
import { runUpgrade, systemUpgradeHost } from "./application/Upgrade.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { createLogger, parseLogLevel, type Logger } from "./logger.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { importReferenceSource } from "./application/ReferenceSourceImport.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";

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
    version: process.env.REA_PACKAGE_VERSION ?? "0.0.0-development",
    description:
      "Reverse engineer anything from your terminal or coding agent.",
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

  registerCoreCommands(cli, logger);
  registerFunctionCommand(cli, logger);
  registerSearchCommand(cli, logger);
  registerXrefsCommand(cli, logger);
  registerTraceCommand(cli, logger);
  registerCapabilityCommands(cli, logger);
  registerNativeCommands(cli, logger);
  registerArtifactCommands(cli, logger);
  registerEvidenceCommands(cli, logger);
  registerReferenceSourceCommand(cli, logger);
  return cli;
};

const registerCoreCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const overviewOptions = z.object({
    detail: z.enum(["concise", "detailed"]).default("concise"),
    limit: z.number().int().min(1).max(50).default(10),
  });
  cli.command("setup", {
    description: "Install requirements and configure coding agents",
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve prerequisite installation"),
    }),
    alias: { yes: "y" },
    run: ({ options }) =>
      logCliCommand(logger, "setup", () => runSetup(options.yes)),
  });
  cli.command("doctor", {
    description: "Check whether REA is ready",
    options: z.object({
      target: z.string().optional().describe("Optional app path to check"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, "doctor", () => runDoctor(options.target)),
  });
  cli.command("uninstall", {
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
  cli.command("upgrade", {
    description: "Upgrade a global npm installation to the latest REA release",
    run: ({ formatExplicit }) =>
      logCliCommand(logger, "upgrade", () =>
        runUpgrade(
          process.env.REA_PACKAGE_VERSION ?? "0.0.0-development",
          systemUpgradeHost(),
          formatExplicit ? "structured" : "human",
        ),
      ),
  });
  cli.command("analyze", {
    description: "Get an overview of an app",
    args: z.object({
      path: z.string().describe("App, program, or Hopper database path"),
    }),
    options: overviewOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "analyze", () =>
        runDirectAnalysis(
          args.path,
          "binary_overview",
          { detail: options.detail, limit: options.limit },
          logger,
        ),
      ),
  });
  cli.command("inspect", {
    description: "Inspect an app overview with evidence",
    args: z.object({
      path: z.string().describe("App, program, or Hopper database path"),
    }),
    options: overviewOptions,
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect", () =>
        runDirectAnalysis(
          args.path,
          "binary_overview",
          { detail: options.detail, limit: options.limit },
          logger,
        ),
      ),
  });
  cli.command("decompile", {
    description: "Read one part of an app as code",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure address"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "decompile", () =>
        runDirectAnalysis(
          args.path,
          "procedure_pseudo_code",
          { procedure: args.address },
          logger,
        ),
      ),
  });
};

const registerXrefsCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("xrefs", {
    description: "List bounded references to an analyzed address",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Hexadecimal address"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "xrefs", () =>
        runDirectAnalysis(
          args.path,
          "xrefs",
          { address: args.address },
          logger,
        ),
      ),
  });
};

const registerTraceCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("trace", {
    description: "Trace a bounded literal feature through analyzed references",
    args: z.object({
      path: z.string().describe("App or program path"),
      query: z.string().min(1).describe("Literal feature query"),
    }),
    options: z.object({
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
      maxOperations: z.number().int().min(1).max(100).default(20),
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
          logger,
        ),
      ),
  });
};

const registerCapabilityCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  for (const command of ["capabilities", "providers"] as const) {
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
  cli.command("function", {
    description: "Analyze one bounded function with evidence",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure name or address"),
    }),
    options: z.object({
      includeAssembly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      maxPseudocodeChars: z.number().int().min(1).max(100_000).default(20_000),
      maxInstructions: z.number().int().min(1).max(5_000).default(500),
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
          logger,
        ),
      ),
  });
};

const registerSearchCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("search", {
    description: "Search bounded analyzed strings or procedure names",
    args: z.object({
      path: z.string().describe("App or program path"),
      pattern: z.string().min(1).describe("Literal text or regex pattern"),
    }),
    options: z.object({
      kind: z.enum(["strings", "procedures"]).default("strings"),
      mode: z.enum(["literal", "regex"]).default("literal"),
      caseSensitive: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(100),
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
          logger,
        ),
      ),
  });
};

const registerReferenceSourceCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("import-reference-source", {
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
          return { error: config.error._tag, message: config.error.message };
        const imported = await importReferenceSource({
          root: args.root,
          caller: "rea-cli",
          policy: config.value.referenceSourcePolicy,
          importer: PRODUCT_IDENTITY.packageName,
          importerVersion: null,
        });
        return imported.ok
          ? imported.value
          : { error: imported.error.code, message: imported.error.message };
      }),
  });
};

const registerArtifactCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("inventory-artifact", {
    description: "Build a bounded deterministic artifact graph",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }),
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
          },
          logger,
        ),
      ),
  });
  cli.command("extract-artifact", {
    description: "Extract explicitly selected artifact occurrences safely",
    args: z.object({
      path: z.string().describe("Application or package path"),
      outputRoot: z.string().describe("Absent absolute output root"),
      occurrenceIds: z
        .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
        .min(1)
        .max(500),
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

const registerNativeCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  for (const [command, tool] of [
    ["inspect-macho", "inspect_macho"],
    ["inspect-signature", "inspect_signature"],
    ["list-architectures", "list_architectures"],
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
  cli.command("inspect-plist", {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({ path: z.string().describe("App or Mach-O path") }),
    options: z.object({
      relativePath: z.string().default("Contents/Info.plist"),
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
  cli.command("demangle-swift", {
    description: "Demangle a bounded Swift symbol batch without Hopper",
    args: z.object({
      path: z.string().describe("Artifact path used for evidence identity"),
      symbols: z.array(z.string().min(1)).min(1).max(500),
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
