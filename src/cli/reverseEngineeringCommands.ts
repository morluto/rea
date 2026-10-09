import { z } from "incur";
import type { Logger } from "pino";

import { createReverseEngineeringService } from "../composition/reverseEngineering.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import { CutterBridgeService } from "../cutter/CutterBridgeService.js";
import { CutterBridgeClient } from "../cutter/CutterBridgeClient.js";

/** Add one-shot reverse-engineering commands using the shared service layer. */
export const registerReverseEngineeringCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createReverseEngineeringService(environment);
  const cutter = new CutterBridgeService(new CutterBridgeClient(environment));
  cli.command(CLI_COMMANDS.inspectWithObjdump, {
    description:
      "Inspect a local artifact with GNU objdump and retain its raw output as Evidence",
    args: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to the local artifact to inspect."),
      operation: z
        .enum([
          "file_headers",
          "section_headers",
          "symbols",
          "relocations",
          "dwarf",
          "disassemble",
          "disassemble_all",
          "architectures",
        ])
        .describe("GNU objdump inspection operation to run."),
    }),
    options: z.object({
      followDebugLinks: z
        .boolean()
        .default(true)
        .describe(
          "Follow local DWARF debug links; network access stays disabled.",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWithObjdump, async () => {
          const result = await service.inspectWithObjdump(
            {
              ...args,
              follow_debug_links: options.followDebugLinks,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.executeRizinCommand, {
    description: "Execute one Rizin command against a local artifact",
    args: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to the local artifact to analyze."),
      command: z.string().min(1).describe("One caller-selected Rizin command."),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.executeRizinCommand, async () => {
          const result = await service.executeRizinCommand(args, { signal });
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.debugWithGdb, {
    description:
      "Run one unrestricted GDB console command in an ephemeral MI session",
    args: z.object({
      command: z
        .string()
        .min(1)
        .describe("One unrestricted GDB console command."),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.debugWithGdb, async () => {
          const manager = new GdbSessionManager({ environment });
          const started = await manager.start(signal);
          if (!started.ok) return projectAnalysisError(started.error);
          try {
            const executed = await manager.execute(
              started.value.session_id,
              args.command,
              signal,
            );
            return executed.ok
              ? executed.value.evidence
              : projectAnalysisError(executed.error);
          } finally {
            const closed = await manager.close(started.value.session_id);
            if (!closed.ok) {
              logger.error(
                {
                  command: CLI_COMMANDS.debugWithGdb,
                  cleanup: projectAnalysisError(closed.error),
                },
                "GDB cleanup failed after collecting command output",
              );
              process.exitCode = 1;
              await manager.closeAll().catch((cause: unknown) => {
                logger.error(
                  {
                    command: CLI_COMMANDS.debugWithGdb,
                    cleanup:
                      cause instanceof Error
                        ? cause.message
                        : "Unknown cleanup failure",
                  },
                  "GDB fallback cleanup failed",
                );
              });
            }
          }
        }),
      ),
  });
  cli.command(CLI_COMMANDS.debugWithRizin, {
    description:
      "Run one unrestricted Rizin debugger command in an ephemeral session",
    args: z.object({
      path: z.string().min(1).describe("Path to the local artifact to debug."),
      command: z
        .string()
        .min(1)
        .describe("One unrestricted Rizin debugger command.")
        .refine((value) => !/[\r\n]/u.test(value)),
    }),
    options: z.object({
      backend: z
        .string()
        .min(1)
        .optional()
        .describe("Optional Rizin IO debugger backend name."),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.debugWithRizin, async () => {
          const manager = new RizinDebugSessionManager(environment);
          const started = await manager.start(
            {
              ...args,
              ...(options.backend === undefined
                ? {}
                : { backend: options.backend }),
            },
            signal,
          );
          if (!started.ok) return projectAnalysisError(started.error);
          try {
            const executed = await manager.execute(
              started.value.session_id,
              args.command,
              signal,
            );
            return executed.ok
              ? executed.value.evidence
              : projectAnalysisError(executed.error);
          } finally {
            const closed = await manager.close(started.value.session_id);
            if (!closed.ok) {
              logger.error(
                {
                  command: CLI_COMMANDS.debugWithRizin,
                  cleanup: projectAnalysisError(closed.error),
                },
                "Rizin cleanup failed after collecting command output",
              );
              process.exitCode = 1;
              await manager.closeAll().catch((cause: unknown) => {
                logger.error(
                  {
                    command: CLI_COMMANDS.debugWithRizin,
                    cleanup:
                      cause instanceof Error
                        ? cause.message
                        : "Unknown cleanup failure",
                  },
                  "Rizin fallback cleanup failed",
                );
              });
            }
          }
        }),
      ),
  });
  cli.command(CLI_COMMANDS.listCutterSessions, {
    description:
      "List live Cutter instances connected through the REA Python plugin bridge",
    args: z.object({}),
    run: () =>
      logCliCommand(logger, CLI_COMMANDS.listCutterSessions, () =>
        cutter.listSessions(),
      ),
  });
  cli.command(CLI_COMMANDS.cutterCommand, {
    description: "Execute one Rizin command in a selected live Cutter instance",
    args: z.object({
      sessionId: z
        .string()
        .uuid()
        .describe("Session ID copied from list-cutter-sessions."),
      expectedGeneration: z
        .number()
        .int()
        .nonnegative()
        .describe("Session generation returned by list-cutter-sessions."),
      command: z
        .string()
        .min(1)
        .describe("One unrestricted Rizin command to run in Cutter.")
        .refine((value) => !/[\r\n]/u.test(value)),
    }),
    options: z.object({
      json: z
        .boolean()
        .default(false)
        .describe("Return command-specific JSON output when available."),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.cutterCommand, async () => {
          const result = await cutter.execute(
            {
              session_id: args.sessionId,
              expected_generation: args.expectedGeneration,
              command: args.command,
              json: options.json,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
