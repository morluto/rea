import { z } from "incur";
import { AndroidAnalysisService } from "../application/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AndroidOperation } from "../domain/androidAnalysis.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose the same explicit APK requests through one-shot CLI commands. */
export const registerAndroidCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new AndroidAnalysisService(
    createAndroidAnalysisProvider(environment),
  );
  const execute = (name: string, operation: AndroidOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );
  const path = z.string().describe("Local standalone APK path");
  const className = z.string().describe("Exact fully qualified class name");
  cli.command(CLI_COMMANDS.inspectAndroidPackage, {
    description:
      "Inspect APK declarations and decoded manifest without executing it",
    args: z.object({ path }),
    run: ({ args }) =>
      execute(
        CLI_COMMANDS.inspectAndroidPackage,
        "inspect_android_package",
        args,
      ),
  });
  cli.command(CLI_COMMANDS.searchAndroidClasses, {
    description: "Search APK class names; empty query inventories all classes",
    args: z.object({
      path,
      query: z
        .string()
        .describe(
          "Case-sensitive class-name substring; empty lists all classes",
        ),
    }),
    run: ({ args }) =>
      execute(
        CLI_COMMANDS.searchAndroidClasses,
        "search_android_classes",
        args,
      ),
  });
  cli.command(CLI_COMMANDS.inspectAndroidClass, {
    description: "Inspect one exact APK class's member inventory",
    args: z.object({ path, className }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectAndroidClass, "inspect_android_class", {
        path: args.path,
        class_name: args.className,
      }),
  });
  cli.command(CLI_COMMANDS.inspectAndroidMethod, {
    description: "Decompile one APK method with explicit overload selection",
    args: z.object({
      path,
      className,
      methodName: z.string().describe("Exact declared method name"),
    }),
    options: z.object({
      overloadIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Explicit zero-based index among same-name methods; required when ambiguous",
        ),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectAndroidMethod, "inspect_android_method", {
        path: args.path,
        class_name: args.className,
        method_name: args.methodName,
        ...(options.overloadIndex === undefined
          ? {}
          : { overload_index: options.overloadIndex }),
      }),
  });
  cli.command(CLI_COMMANDS.traceAndroidReferences, {
    description: "Trace incoming APK class or unique-method references",
    args: z.object({ path, className }),
    options: z.object({
      methodName: z
        .string()
        .optional()
        .describe("Unique declared method name; omit for class references"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.traceAndroidReferences, "trace_android_references", {
        path: args.path,
        class_name: args.className,
        ...(options.methodName === undefined
          ? {}
          : { method_name: options.methodName }),
      }),
  });
};
