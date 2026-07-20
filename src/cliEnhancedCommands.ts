import { Cli, z } from "incur";

import { runDirectAnalysis } from "./application/DirectAnalysis.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import {
  directAnalysisOptions,
  providerSelectionOption,
} from "./cliDirectAnalysisOptions.js";
import { logCliCommand } from "./cliLogging.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

const sharedOptions = z.object({
  snapshot: z
    .string()
    .min(1)
    .optional()
    .describe("Load and update a local analysis snapshot"),
  provider: providerSelectionOption,
});

const registerEnhancedDiscoveryCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.swiftClasses, {
    description: "Discover bounded Swift classes from analyzed procedures",
    args: z.object({
      path: z.string().describe("App or program path"),
      pattern: z.string().default("").describe("Optional literal class filter"),
    }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.swiftClasses,
        path: args.path,
        operation: "swift_classes",
        parameters: {
          pattern: args.pattern,
        },
        options,
      }),
  });
  cli.command(CLI_COMMANDS.objcClasses, {
    description: "Discover bounded Objective-C classes from analyzed names",
    args: z.object({
      path: z.string().describe("App or program path"),
      pattern: z.string().default("").describe("Optional literal class filter"),
    }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.objcClasses,
        path: args.path,
        operation: "get_objc_classes",
        parameters: {
          pattern: args.pattern,
        },
        options,
      }),
  });
  cli.command(CLI_COMMANDS.objcProtocols, {
    description: "Discover bounded Objective-C and Swift protocols",
    args: z.object({ path: z.string().describe("App or program path") }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.objcProtocols,
        path: args.path,
        operation: "get_objc_protocols",
        parameters: {},
        options,
      }),
  });
  cli.command(CLI_COMMANDS.batchDecompile, {
    description: "Decompile up to twenty explicit procedures concurrently",
    args: z.object({
      path: z.string().describe("App or program path"),
      addresses: z
        .array(z.string().describe("Procedure symbol or address"))
        .max(20)
        .describe("Procedures to decompile"),
    }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.batchDecompile,
        path: args.path,
        operation: "batch_decompile",
        parameters: {
          addresses: [...args.addresses],
        },
        options,
      }),
  });
};

const registerEnhancedRelationshipCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.callGraph, {
    description: "Traverse bounded caller or callee relationships",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Starting procedure symbol or address"),
    }),
    options: sharedOptions.extend({
      direction: z
        .enum(["forward", "backward"])
        .default("forward")
        .describe("Traverse callees forward or callers backward"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(2)
        .describe("Maximum relationship depth"),
    }),
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.callGraph,
        path: args.path,
        operation: "get_call_graph",
        parameters: {
          address: args.address,
          direction: options.direction,
          depth: options.depth,
        },
        options,
      }),
  });
  cli.command(CLI_COMMANDS.analyzeSwiftTypes, {
    description: "Categorize bounded Swift type symbols",
    args: z.object({ path: z.string().describe("App or program path") }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.analyzeSwiftTypes,
        path: args.path,
        operation: "analyze_swift_types",
        parameters: {},
        options,
      }),
  });
  cli.command(CLI_COMMANDS.xrefsToName, {
    description: "Resolve an exact analyzed name to bounded references",
    args: z.object({
      path: z.string().describe("App or program path"),
      name: z.string().describe("Exact analyzed name to resolve"),
    }),
    options: sharedOptions,
    run: ({ args, options }) =>
      runEnhanced({
        logger,
        command: CLI_COMMANDS.xrefsToName,
        path: args.path,
        operation: "find_xrefs_to_name",
        parameters: {
          name: args.name,
        },
        options,
      }),
  });
};

/** Register one-shot CLI adapters for every enhanced workflow not otherwise exposed. */
export const registerEnhancedAnalysisCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerEnhancedDiscoveryCommands(cli, logger);
  registerEnhancedRelationshipCommands(cli, logger);
};

type SharedOptions = {
  readonly snapshot?: string | undefined;
  readonly provider?: z.output<typeof providerSelectionOption>;
};

type EnhancedRun = {
  readonly logger: Logger;
  readonly command: string;
  readonly path: string;
  readonly operation:
    | "swift_classes"
    | "get_objc_classes"
    | "get_objc_protocols"
    | "batch_decompile"
    | "get_call_graph"
    | "analyze_swift_types"
    | "find_xrefs_to_name";
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly options: SharedOptions;
};

const runEnhanced = ({
  logger,
  command,
  path,
  operation,
  parameters,
  options,
}: EnhancedRun) =>
  logCliCommand(logger, command, () =>
    runDirectAnalysis(
      path,
      operation,
      parameters,
      directAnalysisOptions(logger, options.snapshot, options.provider),
    ),
  );
