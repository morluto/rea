import { z } from "incur";

import { runDirectAnalysis } from "../application/DirectAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "../logger.js";
import { directAnalysisOptions, providerSelectionOption } from "./options.js";
import type { CliInstance } from "./types.js";

export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerCoreCommands(cli, logger);
  registerFunctionCommand(cli, logger);
  registerSearchCommand(cli, logger);
  registerXrefsCommand(cli, logger);
  registerTraceCommand(cli, logger);
};

const registerCoreCommands = (cli: CliInstance, logger: Logger): void => {
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

const registerTraceCommand = (cli: CliInstance, logger: Logger): void => {
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

const registerFunctionCommand = (cli: CliInstance, logger: Logger): void => {
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

const registerSearchCommand = (cli: CliInstance, logger: Logger): void => {
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
