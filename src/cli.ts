import { Cli, z } from "incur";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./application/Doctor.js";
import {
  runDirectAnalysis,
  runProviderAnalysis,
} from "./application/DirectAnalysis.js";
import { runSetup } from "./application/Setup.js";
import { runUninstall } from "./application/Uninstall.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { createLogger, parseLogLevel, type Logger } from "./logger.js";
import { parseConfig } from "./config.js";
import {
  exportEvidenceBundleCommand,
  importEvidenceBundleCommand,
} from "./application/EvidenceBundleCommands.js";
import { importReferenceSource } from "./application/ReferenceSourceImport.js";

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
  cli.command("analyze", {
    description: "Get an overview of an app",
    args: z.object({
      path: z.string().describe("App, program, or Hopper database path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "analyze", () =>
        runDirectAnalysis(args.path, "binary_overview", {}, logger),
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
  registerNativeCommands(cli, logger);
  registerArtifactCommands(cli, logger);
  registerEvidenceCommands(cli, logger);
  registerReferenceSourceCommand(cli, logger);
  return cli;
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

const registerEvidenceCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("evidence-import", {
    description: "Validate and import a bounded local Evidence v2 bundle",
    args: z.object({
      path: z.string().describe("Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "evidence-import", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return { error: config.error._tag, message: config.error.message };
        const imported = await importEvidenceBundleCommand(
          args.path,
          config.value.evidenceFilePolicy,
        );
        return imported.ok
          ? imported.value
          : { error: imported.error._tag, message: imported.error.message };
      }),
  });
  cli.command("evidence-export", {
    description: "Validate and atomically export canonical Evidence v2 JSON",
    args: z.object({
      source: z.string().describe("Existing evidence bundle JSON path"),
      output: z.string().describe("Canonical output JSON path"),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe("Replace output file"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "evidence-export", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return { error: config.error._tag, message: config.error.message };
        const exported = await exportEvidenceBundleCommand(
          args.source,
          args.output,
          options.overwrite,
          config.value.evidenceFilePolicy,
        );
        return exported.ok
          ? exported.value
          : { error: exported.error._tag, message: exported.error.message };
      }),
  });
};

const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    logger.info(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "ok",
      },
      "CLI command completed",
    );
    return value;
  } catch (cause: unknown) {
    logger.error(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "error",
      },
      "CLI command failed",
    );
    throw cause;
  }
};
