import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import type { JebAnalysisPort } from "../application/jeb/JebAnalysisPort.js";
import { createJebAnalysisProvider } from "../composition/jeb.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JebOperation } from "../domain/jeb/jebAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit JEB requests through one-shot CLI commands. */
export const registerJebCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: JebAnalysisPort = createJebAnalysisProvider(environment),
): void => {
  const service = new JebAnalysisService(provider);
  const execute = (name: string, operation: JebOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        try {
          await provider.close();
        } catch (cause) {
          if (cause instanceof AnalysisError)
            return projectAnalysisError(cause);
          throw cause;
        }
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );

  cli.command(CLI_COMMANDS.inspectJebClient, {
    description: "Inspect the running JEB MCP client without opening a target",
    args: z.object({}),
    run: () => execute(CLI_COMMANDS.inspectJebClient, "inspect_jeb_client", {}),
  });
  cli.command(CLI_COMMANDS.openJebProject, {
    description:
      "Open or create a JEB project from an artifact or .jdb2 database",
    args: z.object({
      path: z
        .string()
        .describe("Artifact or .jdb2 path resolved by the JEB engine host"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.openJebProject, "open_jeb_project", args),
  });
  cli.command(CLI_COMMANDS.listJebUnits, {
    description: "List JEB project units by path and type with optional filter",
    args: z.object({
      filter: z
        .string()
        .optional()
        .describe("Wildcard filter matched against unit paths"),
      "parent-unit-path": z
        .string()
        .optional()
        .describe("Restrict results to descendants of this unit path"),
      index: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Zero-based index of the first result to return"),
      count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(100)
        .describe("Maximum results; the engine caps unit pages at 100"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listJebUnits, "list_jeb_units", {
        index: args.index,
        count: args.count,
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args["parent-unit-path"] === undefined
          ? {}
          : { parent_unit_path: args["parent-unit-path"] }),
      }),
  });
  cli.command(CLI_COMMANDS.decompileJebItem, {
    description: "Decompile one JEB type or method to engine pseudo-code",
    args: z.object({
      "item-address": z
        .string()
        .min(1)
        .describe("Type or method address within the unit"),
      "item-kind": z
        .enum(["type", "method"])
        .describe("Kind of item to decompile"),
      "unit-path": z
        .string()
        .min(1)
        .optional()
        .describe(
          "Target code unit; the engine's first code unit when omitted",
        ),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.decompileJebItem, "decompile_jeb_item", {
        item_address: args["item-address"],
        item_kind: args["item-kind"],
        ...(args["unit-path"] === undefined
          ? {}
          : { unit_path: args["unit-path"] }),
      }),
  });
};
