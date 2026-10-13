import { z } from "incur";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import {
  directAnalysisOptionsFromCli,
  nativeOpenOptionFields,
} from "./options.js";
import type { CliInstance } from "./types.js";

/** Register native load-image, memory, and annotation CLI commands. */
export const registerCoreNativeCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  registerAnnotationCommand(cli, logger, runDirectAnalysis);
  cli.command(CLI_COMMANDS.searchBytes, {
    description: "Find masked byte patterns in initialized provider memory",
    args: z.object({
      path: z.string().describe("Local executable path"),
      pattern: z.string().describe("Hexadecimal byte pairs with ?? wildcards"),
    }),
    options: z.object({
      mask: z.string().optional().describe("Equal-length hexadecimal bit mask"),
      start: z.string().optional().describe("Inclusive start address"),
      end: z.string().optional().describe("Inclusive end address"),
      cursor: z
        .string()
        .optional()
        .describe("Continuation from the same query's next_cursor"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum matches on this page"),
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.searchBytes, () =>
        runDirectAnalysis(
          args.path,
          "search_bytes",
          {
            pattern: args.pattern,
            limit: options.limit,
            ...(options.mask === undefined ? {} : { mask: options.mask }),
            ...(options.start === undefined ? {} : { start: options.start }),
            ...(options.end === undefined ? {} : { end: options.end }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          },
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.inspectNativeLoadImage, {
    description:
      "Verify loaded native bytes, source mappings, relocations and entry",
    args: z.object({ path: z.string().describe("Local executable path") }),
    options: z.object({
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectNativeLoadImage, () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_load_image",
          {},
          directAnalysisOptionsFromCli(logger, options),
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
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.readBytes, () =>
        runDirectAnalysis(
          args.path,
          "read_bytes",
          { address: args.address, length: options.length },
          directAnalysisOptionsFromCli(logger, options),
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
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.addressToFileOffset, () =>
        runDirectAnalysis(
          args.path,
          "address_to_file_offset",
          { address: args.address },
          directAnalysisOptionsFromCli(logger, options),
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
      ...nativeOpenOptionFields,
    }),
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
          directAnalysisOptionsFromCli(logger, options),
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
      address: z.string().optional().describe("Exact native address"),
      ...nativeOpenOptionFields,
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
          directAnalysisOptionsFromCli(logger, options),
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
        ...nativeOpenOptionFields,
      }),
      run: ({ args, options }) =>
        logCliCommand(logger, command, () =>
          runDirectAnalysis(
            args.path,
            operation,
            { address: args.address },
            directAnalysisOptionsFromCli(logger, options),
          ),
        ),
    });
  }
  registerNativeApiCommand(cli, logger, runDirectAnalysis);
  registerNativeUiActionCommand(cli, logger, runDirectAnalysis);
  registerNativeDispatchMetadataCommand(cli, logger, runDirectAnalysis);
};

const registerNativeDispatchMetadataCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
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
      ...nativeOpenOptionFields,
    }),
    run: async ({ args, options }) =>
      logCliCommand(logger, "inspect-native-dispatch-metadata", () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_dispatch_metadata",
          { max_records: options.maxRecords },
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerNativeUiActionCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
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
      ...nativeOpenOptionFields,
    }),
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
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerNativeApiCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
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
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-native-api", () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_api",
          { procedure: args.address },
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};

const registerAnnotationCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.annotateNativeFunction, {
    description: "Edit function annotations and return refreshed analysis",
    args: z.object({
      path: z.string().describe("Local executable path"),
      procedure: z
        .string()
        .describe("Exact function entry address or unique name"),
    }),
    options: z.object({
      name: z.string().min(1).optional().describe("Analyst function name"),
      comment: z
        .string()
        .optional()
        .describe("Regular entry comment; empty text clears it"),
      "inline-comment": z
        .string()
        .optional()
        .describe("Inline entry comment; empty text clears it"),
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.annotateNativeFunction, () =>
        runDirectAnalysis(
          args.path,
          "annotate_native_function",
          {
            procedure: args.procedure,
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.comment === undefined
              ? {}
              : { comment: options.comment }),
            ...(options["inline-comment"] === undefined
              ? {}
              : { inline_comment: options["inline-comment"] }),
          },
          directAnalysisOptionsFromCli(logger, options),
        ),
      ),
  });
};
