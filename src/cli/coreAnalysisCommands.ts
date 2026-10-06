import { z } from "incur";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { runDirectAnalysis } from "../application/DirectAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "../logger.js";
import {
  directAnalysisOptions,
  formatSelectionOption,
  providerSelectionOption,
} from "./options.js";
import type { CliInstance } from "./types.js";
import { runCliJavaScriptApplicationAnalysis } from "./javascriptApplicationAnalysis.js";

export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerCoreCommands(cli, logger);
  cli.command(CLI_COMMANDS.inspectNativeLoadImage, {
    description:
      "Verify loaded native bytes, source mappings, relocations and entry",
    args: z.object({ path: z.string().describe("Local executable path") }),
    options: z.object({
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectNativeLoadImage, () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_load_image",
          {},
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.readBytes, {
    description: "Read exact provider memory bytes at one analysis address",
    args: z.object({
      path: z.string().describe("Local executable path"),
      address: z.string().describe("Exact provider memory address"),
    }),
    options: z.object({
      length: z
        .number()
        .int()
        .min(1)
        .default(256)
        .describe("Requested byte count"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.readBytes, () =>
        runDirectAnalysis(
          args.path,
          "read_bytes",
          { address: args.address, length: options.length },
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.addressToFileOffset, {
    description: "Resolve an analysis address to its original file byte offset",
    args: z.object({
      path: z.string().describe("Local executable path"),
      address: z.string().describe("Exact provider memory address"),
    }),
    options: z.object({
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.addressToFileOffset, () =>
        runDirectAnalysis(
          args.path,
          "address_to_file_offset",
          { address: args.address },
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.traceNativeValues, {
    description: "Trace bounded native def-use and call dependencies",
    args: z.object({
      path: z.string().describe("Local native executable or app path"),
      procedure: z
        .string()
        .describe("Explicit native procedure symbol or address"),
    }),
    options: z.object({
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(16)
        .default(3)
        .describe("Maximum call traversal depth"),
      maxFunctions: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(16)
        .describe("Maximum function decompilations"),
      maxCallSites: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .default(256)
        .describe("Maximum static call-site resolutions"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .default(5000)
        .describe("Maximum retained graph nodes"),
      maxEdges: z
        .number()
        .int()
        .min(1)
        .max(40000)
        .default(10000)
        .describe("Maximum retained graph edges"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("First graph node index"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(1000)
        .describe("Maximum nodes on this page"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    alias: {
      maxDepth: "max-depth",
      maxFunctions: "max-functions",
      maxCallSites: "max-call-sites",
      maxNodes: "max-nodes",
      maxEdges: "max-edges",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.traceNativeValues, () =>
        runDirectAnalysis(
          args.path,
          "trace_native_values",
          {
            procedure: args.procedure,
            max_depth: options.maxDepth,
            max_functions: options.maxFunctions,
            max_call_sites: options.maxCallSites,
            max_nodes: options.maxNodes,
            max_edges: options.maxEdges,
            offset: options.offset,
            limit: options.limit,
          },
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.inspectNativeDataType, {
    description: "Inspect one recovered database type or typed data object",
    args: z.object({
      path: z.string().describe("Local native executable or app path"),
    }),
    options: z.object({
      type: z.string().optional().describe("Exact database type category path"),
      address: z.string().describe("Exact native address").optional(),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectNativeDataType, () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_data_type",
          {
            ...(options.type === undefined ? {} : { type: options.type }),
            ...(options.address === undefined
              ? {}
              : { address: options.address }),
          },
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
  for (const [command, operation] of [
    [CLI_COMMANDS.inspectNativeInstruction, "inspect_native_instruction"],
    [CLI_COMMANDS.resolveNativeCallTargets, "resolve_native_call_targets"],
  ] as const) {
    cli.command(command, {
      description:
        operation === "inspect_native_instruction"
          ? "Inspect one native instruction with decoded operand facts"
          : "Resolve one static native call site",
      args: z.object({
        path: z.string().describe("Local native executable or app path"),
        address: z.string().describe("Exact native address"),
      }),
      options: z.object({
        "target-format": formatSelectionOption,
        provider: providerSelectionOption,
      }),
      run: ({ args, options }) =>
        logCliCommand(logger, command, () =>
          runDirectAnalysis(
            args.path,
            operation,
            { address: args.address },
            directAnalysisOptions(
              logger,
              undefined,
              options.provider,
              options["target-format"],
            ),
          ),
        ),
    });
  }
  registerFunctionCommand(cli, logger);
  registerNativeApiCommand(cli, logger);
  registerInstructionsCommand(cli, logger);
  registerSearchCommand(cli, logger);
  registerXrefsCommand(cli, logger);
  registerTraceCommand(cli, logger);
  registerNativeUiActionCommand(cli, logger);
  registerNativeDispatchMetadataCommand(cli, logger);
};

const registerNativeDispatchMetadataCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectNativeDispatchMetadata, {
    description: "Inspect typed Objective-C and Swift dispatch metadata",
    args: z.object({
      path: z.string().describe("Target path used to bind the result evidence"),
    }),
    options: z.object({
      maxRecords: z
        .number()
        .int()
        .min(1)
        .max(20_000)
        .default(5_000)
        .describe("Maximum symbol records to inspect"),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load or update the local analysis snapshot"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    alias: { maxRecords: "max-records" },
    run: async ({ args, options }) =>
      logCliCommand(logger, "inspect-native-dispatch-metadata", () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_dispatch_metadata",
          { max_records: options.maxRecords },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerNativeUiActionCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.traceNativeUiAction, {
    description:
      "Trace a compiled UI action selector to its native handler and direct callees",
    args: z.object({
      path: z.string().describe("Target path used to bind the result evidence"),
      action: z
        .string()
        .min(1)
        .describe(
          "A unique compiled UI action selector or interface object ID",
        ),
    }),
    options: z.object({
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(32)
        .default(8)
        .describe("Maximum relationship depth"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(2_000)
        .default(250)
        .describe("Maximum returned graph nodes"),
      maxEdges: z
        .number()
        .int()
        .min(1)
        .max(5_000)
        .default(500)
        .describe("Maximum returned graph edges"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    alias: {
      maxDepth: "max-depth",
      maxNodes: "max-nodes",
      maxEdges: "max-edges",
    },
    run: async ({ args, options }) =>
      logCliCommand(logger, "trace-native-ui-action", () =>
        runDirectAnalysis(
          args.path,
          "trace_native_ui_action",
          {
            action: args.action,
            max_depth: options.maxDepth,
            max_nodes: options.maxNodes,
            max_edges: options.maxEdges,
          },
          directAnalysisOptions(
            logger,
            undefined,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerCoreCommands = (cli: CliInstance, logger: Logger): void => {
  const overviewOptions = z.object({
    snapshot: z
      .string()
      .min(1)
      .optional()
      .describe("Load and update a local analysis snapshot"),
    "target-format": formatSelectionOption,
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
        runRoutedOverview(args.path, options, logger),
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
          {},
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
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
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "decompile", () =>
        runDirectAnalysis(
          args.path,
          "procedure_pseudo_code",
          { procedure: args.address },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const runRoutedOverview = async (
  path: string,
  options: {
    readonly snapshot?: string | undefined;
    readonly "target-format"?: "dos-com" | undefined;
    readonly provider?: string | undefined;
  },
  logger: Logger,
) => {
  if (
    options.provider === undefined &&
    options.snapshot === undefined &&
    options["target-format"] === undefined &&
    (await isJavaScriptApplicationPath(path))
  )
    return runCliJavaScriptApplicationAnalysis({
      input_path: resolve(path),
    });
  return runDirectAnalysis(
    path,
    "binary_overview",
    {},
    directAnalysisOptions(
      logger,
      options.snapshot,
      options.provider,
      options["target-format"],
    ),
  );
};

const isJavaScriptApplicationPath = async (path: string): Promise<boolean> => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".asar")) return true;
  if (lower.endsWith(".app")) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch (cause: unknown) {
    // A missing or unreadable path is not a JavaScript application directory;
    // the caller falls through to direct binary analysis instead.
    void cause;
    return false;
  }
};

const registerXrefsCommand = (cli: CliInstance, logger: Logger): void => {
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
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "xrefs", () =>
        runDirectAnalysis(
          args.path,
          "xrefs",
          { address: args.address },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerTraceCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.trace, {
    description: "Trace a literal feature through analyzed references",
    args: z.object({
      path: z.string().describe("App or program path"),
      query: z.string().min(1).describe("Literal feature query"),
    }),
    options: z.object({
      caseSensitive: z
        .boolean()
        .default(false)
        .describe("Match the query with exact letter case"),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    alias: {
      caseSensitive: "case-sensitive",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "trace", () =>
        runDirectAnalysis(
          args.path,
          "trace_feature",
          {
            query: args.query,
            case_sensitive: options.caseSensitive,
          },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerFunctionCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.function, {
    description: "Analyze one complete function with evidence",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure name or address"),
    }),
    options: z.object({
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "function", () =>
        runDirectAnalysis(
          args.path,
          "analyze_function",
          { procedure: args.address },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerNativeApiCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.inspectNativeApi, {
    description: "Reconstruct one native function API boundary with evidence",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure name or address"),
    }),
    options: z.object({
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-native-api", () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_api",
          { procedure: args.address },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerInstructionsCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.instructions, {
    description: "Read every raw instruction without decompiling",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure name or address"),
    }),
    options: z.object({
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      "target-format": formatSelectionOption,
      provider: providerSelectionOption,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.instructions, () =>
        runDirectAnalysis(
          args.path,
          "read_function_instructions",
          {
            procedure: args.address,
          },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};

const registerSearchCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.search, {
    description: "Search every analyzed string or procedure name",
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
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      "target-format": formatSelectionOption,
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
          },
          directAnalysisOptions(
            logger,
            options.snapshot,
            options.provider,
            options["target-format"],
          ),
        ),
      ),
  });
};
