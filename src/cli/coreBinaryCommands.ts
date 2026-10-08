import { z } from "incur";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveCliAnalysisSelector } from "./analysisSelector.js";
import { runDirectAnalysis } from "../composition/directAnalysis.js";
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
import type {
  CliCommandOutput,
  CliResultOutput,
} from "./streamedJsonOutput.js";

/** Register provider-neutral binary overview and procedure CLI commands. */
export const registerCoreBinaryCommands = (
  cli: CliInstance,
  logger: Logger,
  resultOutput?: CliResultOutput,
): void => {
  registerOverviewCommands(cli, logger, resultOutput);
  registerDecompileCommand(cli, logger);
  registerFunctionCommand(cli, logger);
  registerInstructionsCommand(cli, logger);
  registerSearchCommand(cli, logger);
  registerXrefsCommand(cli, logger);
  registerTraceCommand(cli, logger);
};

const registerOverviewCommands = (
  cli: CliInstance,
  logger: Logger,
  resultOutput?: CliResultOutput,
): void => {
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
    run: ({ args, options, format }) =>
      logCliCommand(logger, "analyze", () =>
        runRoutedOverview(
          args.path,
          options,
          logger,
          resultOutput === undefined
            ? undefined
            : { output: resultOutput, command: CLI_COMMANDS.analyze, format },
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
};

const registerDecompileCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.decompile, {
    description: "Read one part of an app as code",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z
        .string()
        .min(1)
        .optional()
        .describe("Procedure name or address"),
    }),
    options: z.object({
      procedure: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Procedure name or address; use --procedure=<value> for leading dashes",
        ),
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
          {
            procedure: resolveCliAnalysisSelector(
              args.address,
              options.procedure,
              "procedure",
              "procedure_pseudo_code",
            ),
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

const runRoutedOverview = async (
  path: string,
  options: {
    readonly snapshot?: string | undefined;
    readonly "target-format"?: "dos-com" | undefined;
    readonly provider?: string | undefined;
  },
  logger: Logger,
  output?: CliCommandOutput,
) => {
  if (
    options.provider === undefined &&
    options.snapshot === undefined &&
    options["target-format"] === undefined &&
    (await isJavaScriptApplicationPath(path))
  )
    return runCliJavaScriptApplicationAnalysis(
      { input_path: resolve(path) },
      output,
    );
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
      address: z.string().min(1).optional().describe("Address or symbol name"),
    }),
    options: z.object({
      address: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Address or symbol name; use --address=<value> for leading dashes",
        ),
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
          {
            address: resolveCliAnalysisSelector(
              args.address,
              options.address,
              "address",
              "xrefs",
            ),
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

const registerTraceCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.trace, {
    description: "Trace a literal feature through analyzed references",
    args: z.object({
      path: z.string().describe("App or program path"),
      query: z.string().min(1).optional().describe("Literal feature query"),
    }),
    options: z.object({
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Complete literal feature query; use --query=<value> for leading dashes",
        ),
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
            query: resolveCliAnalysisSelector(
              args.query,
              options.query,
              "query",
              "trace_feature",
            ),
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
      address: z
        .string()
        .min(1)
        .optional()
        .describe("Procedure name or address"),
    }),
    options: z.object({
      procedure: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Procedure name or address; use --procedure=<value> for leading dashes",
        ),
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
          {
            procedure: resolveCliAnalysisSelector(
              args.address,
              options.procedure,
              "procedure",
              "analyze_function",
            ),
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

const registerInstructionsCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.instructions, {
    description: "Read every raw instruction without decompiling",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z
        .string()
        .min(1)
        .optional()
        .describe("Procedure name or address"),
    }),
    options: z.object({
      procedure: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Procedure name or address; use --procedure=<value> for leading dashes",
        ),
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
            procedure: resolveCliAnalysisSelector(
              args.address,
              options.procedure,
              "procedure",
              "read_function_instructions",
            ),
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
      pattern: z
        .string()
        .min(1)
        .optional()
        .describe("Literal text or regex pattern"),
    }),
    options: z.object({
      pattern: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Complete literal text or regex pattern; use --pattern=<value> for leading dashes",
        ),
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
            pattern: resolveCliAnalysisSelector(
              args.pattern,
              options.pattern,
              "pattern",
              options.kind === "strings"
                ? "search_strings"
                : "search_procedures",
            ),
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
