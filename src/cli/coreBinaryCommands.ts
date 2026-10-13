import { z } from "incur";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveCliAnalysisSelector } from "./analysisSelector.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import {
  directAnalysisOptionsFromCli,
  nativeOpenOptionFields,
} from "./options.js";
import type { CliInstance } from "./types.js";
import { runCliJavaScriptApplicationAnalysis } from "./javascriptApplicationAnalysis.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { javascriptApplicationOptions } from "../cliObservationOptions.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/** Register provider-neutral binary overview and procedure CLI commands. */
export const registerCoreBinaryCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  registerOverviewCommands(cli, logger, runDirectAnalysis);
  registerDecompileCommand(cli, logger, runDirectAnalysis);
  registerFunctionCommand(cli, logger, runDirectAnalysis);
  registerInstructionsCommand(cli, logger, runDirectAnalysis);
  registerSearchCommand(cli, logger, runDirectAnalysis);
  registerXrefsCommand(cli, logger, runDirectAnalysis);
  registerTraceCommand(cli, logger, runDirectAnalysis);
};

const registerOverviewCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  const overviewOptions = z.object({
    snapshot: z
      .string()
      .min(1)
      .optional()
      .describe("Load and update a local analysis snapshot"),
    ...nativeOpenOptionFields,
  });
  cli.command(CLI_COMMANDS.analyze, {
    description: "Get an overview of an app",
    args: z.object({
      path: z.string().describe("App, program, or analysis database path"),
    }),
    options: overviewOptions.extend({
      integrityPolicy: javascriptApplicationOptions.shape.integrityPolicy,
      sourcePath: javascriptApplicationOptions.shape.sourcePath,
    }),
    run: async ({ args, options }) => {
      // Route JavaScript targets exactly like analyze-javascript-application,
      // including typed cancellation; cancellation wraps logging so its exit
      // code is not replaced by the logged failure status.
      if (await routesToJavaScriptAnalysis(args.path, options))
        return withCommandCancellation((signal) =>
          logCliCommand(logger, "analyze", () =>
            runCliJavaScriptApplicationAnalysis(
              {
                input_path: resolve(args.path),
                integrity_policy: options.integrityPolicy,
                ...(options.sourcePath === undefined
                  ? {}
                  : { source_paths: options.sourcePath }),
              },
              signal,
            ),
          ),
        );
      return logCliCommand(logger, "analyze", () => {
        if (options.sourcePath !== undefined)
          throw new AnalysisInputError(
            "analyze_javascript_application",
            undefined,
            [
              {
                path: ["source_paths"],
                reason: "invalid_value",
                message:
                  "Source selection requires the static JavaScript ASAR/directory analysis lane.",
              },
            ],
          );
        return runDirectAnalysis(
          args.path,
          "binary_overview",
          {},
          directAnalysisOptionsFromCli(logger, options),
        );
      });
    },
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerDecompileCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      "file-offset": z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/u)
        .optional()
        .describe(
          "Ghidra source-file byte offset; mapped internally to an analysis address",
        ),
      snapshot: z
        .string()
        .min(1)
        .optional()
        .describe("Load and update a local analysis snapshot"),
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "decompile", () =>
        runDirectAnalysis(
          args.path,
          "procedure_pseudo_code",
          {
            procedure: resolveCliAnalysisSelector(
              args.address,
              options["file-offset"] === undefined
                ? options.procedure
                : resolveCliAnalysisSelector(
                    options.procedure,
                    `file-offset:${options["file-offset"]}`,
                    "file-offset",
                    "procedure_pseudo_code",
                  ),
              options["file-offset"] === undefined
                ? "procedure"
                : "file-offset",
              "procedure_pseudo_code",
            ),
          },
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

/** Select static JavaScript analysis only when no binary-analysis option applies. */
const routesToJavaScriptAnalysis = async (
  path: string,
  options: {
    readonly snapshot?: string | undefined;
    readonly "target-format"?: "dos-com" | "raw-binary" | undefined;
    readonly architecture?: string | undefined;
    readonly "entry-point"?: string | undefined;
    readonly provider?: string | undefined;
  },
): Promise<boolean> =>
  options.provider === undefined &&
  options.snapshot === undefined &&
  options["target-format"] === undefined &&
  options.architecture === undefined &&
  options["entry-point"] === undefined &&
  (await isJavaScriptApplicationPath(path));

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

const registerXrefsCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      ...nativeOpenOptionFields,
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerTraceCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      ...nativeOpenOptionFields,
    }),
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerFunctionCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      ...nativeOpenOptionFields,
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerInstructionsCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
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
      ...nativeOpenOptionFields,
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerSearchCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      ...nativeOpenOptionFields,
    }),
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};
