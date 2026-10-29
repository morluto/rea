import { z } from "incur";
import type { Logger } from "pino";

import { createReverseEngineeringService } from "../composition/reverseEngineering.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { evidenceSchema, type Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { err } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  OBJDUMP_ARTIFACT_OPERATIONS,
  reverseCommandTimeoutSchema,
} from "../domain/reverseEngineering.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import {
  GdbSessionManager,
  gdbOneShotCommandMayInvalidateDetachProof,
} from "../gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

const executeWithCleanup = async (
  service: ReverseEngineeringService,
  signal: AbortSignal,
  execute: () => Promise<Result<Evidence, AnalysisError>>,
): Promise<Result<Evidence, AnalysisError>> => {
  let result: Result<Evidence, AnalysisError>;
  try {
    result = await execute();
  } catch (cause) {
    await service.close().catch(() => undefined);
    throw cause;
  }
  const hadIncompleteCleanup = !result.ok && result.error.cleanupIncomplete;
  try {
    await service.close();
  } catch (cause) {
    if (result.ok) return err(asCleanupError(cause));
    const cleanup = cause instanceof AnalysisError ? cause.cleanup : undefined;
    const error = new AnalysisOutputError(
      "reverse_engineering_cleanup",
      "Provider cleanup remains incomplete after the command failed.",
      {
        cause: result.error,
        ...(cleanup === undefined ? {} : { cleanup }),
        ...(result.error.capturedOutput === undefined
          ? {}
          : { capturedOutput: result.error.capturedOutput }),
        ...(result.error.partialObservation === undefined
          ? {}
          : { partialObservation: result.error.partialObservation }),
      },
    );
    return err(error);
  }
  if (!result.ok && hadIncompleteCleanup && !result.error.cleanupIncomplete) {
    const evidence = cleanupOnlyCompleteEvidence(result.error);
    if (evidence !== undefined)
      return cancelledAfterCleanup({ ok: true, value: evidence }, signal);
  }
  return cancelledAfterCleanup(result, signal);
};

/** Late cancellation observed during finalization keeps the completed Evidence as partial data. */
const cancelledAfterCleanup = (
  result: Result<Evidence, AnalysisError>,
  signal: AbortSignal,
): Result<Evidence, AnalysisError> =>
  result.ok && signal.aborted
    ? err(
        new AnalysisCancelledError(result.value.operation, {
          cause: signal.reason,
          partialObservation: result.value,
        }),
      )
    : result;

const cleanupOnlyCompleteEvidence = (
  error: AnalysisError,
): Evidence | undefined => {
  if (
    !(error instanceof AnalysisOutputError) ||
    !error.cleanupOnly ||
    error.partialObservation === undefined
  )
    return undefined;
  const parsed = evidenceSchema.safeParse(error.partialObservation);
  if (!parsed.success) return undefined;
  const normalized = parsed.data.normalized_result;
  return typeof normalized === "object" &&
    normalized !== null &&
    !Array.isArray(normalized) &&
    normalized.completion_status === "complete"
    ? parsed.data
    : undefined;
};

const asCleanupError = (cause: unknown): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new AnalysisOutputError(
        "reverse_engineering_cleanup",
        "Provider process cleanup failed.",
        { cause },
      );

/** Add one-shot reverse-engineering commands using the shared service layer. */
export const registerReverseEngineeringCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  createGdbManager: (
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => GdbSessionManager = (providerEnvironment) =>
    new GdbSessionManager({ environment: providerEnvironment }),
  createService: typeof createReverseEngineeringService = createReverseEngineeringService,
): void => {
  const service = createService(environment);
  cli.command(CLI_COMMANDS.inspectWithObjdump, {
    description:
      "Inspect a local artifact with GNU objdump and retain its raw output as Evidence",
    args: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to the local artifact to inspect."),
      operation: z
        .enum(OBJDUMP_ARTIFACT_OPERATIONS)
        .describe("GNU objdump inspection operation to run."),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      symbol: z
        .string()
        .optional()
        .describe(
          "Native symbol to select with the disassemble operation; GNU objdump controls matching and boundaries.",
        ),
      followDebugLinks: z
        .boolean()
        .default(false)
        .describe(
          "Follow local DWARF debug links. External debug-file identity is not bound to Evidence.",
        ),
      commandTimeoutMs: reverseCommandTimeoutSchema,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectWithObjdump, async () => {
          const delivery = {
            providerId: "gnu.objdump",
            operation: "inspect_with_objdump",
            signal,
            detail: options.detail,
            evidenceOutput: options.evidence_output,
          };
          const inputError = cliEvidenceDeliveryInputError(delivery);
          if (inputError !== undefined) return projectAnalysisError(inputError);
          const result = await executeWithCleanup(service, signal, () =>
            service.inspectWithObjdump(
              {
                ...args,
                follow_debug_links: options.followDebugLinks,
                ...(options.symbol === undefined
                  ? {}
                  : { symbol: options.symbol }),
                ...(options.commandTimeoutMs === undefined
                  ? {}
                  : { command_timeout_ms: options.commandTimeoutMs }),
              },
              { signal },
            ),
          );
          return result.ok
            ? publishCliAnalysisEvidence(
                { ok: true, value: result.value },
                delivery,
              )
            : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.listObjdumpArchitectures, {
    description: "List BFD targets advertised by the installed GNU objdump",
    args: z.object({}),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      commandTimeoutMs: reverseCommandTimeoutSchema,
    }),
    run: ({ options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.listObjdumpArchitectures,
          async () => {
            const delivery = {
              providerId: "gnu.objdump",
              operation: "inspect_with_objdump",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            };
            const inputError = cliEvidenceDeliveryInputError(delivery);
            if (inputError !== undefined)
              return projectAnalysisError(inputError);
            const result = await executeWithCleanup(service, signal, () =>
              service.inspectWithObjdump(
                {
                  operation: "architectures",
                  ...(options.commandTimeoutMs === undefined
                    ? {}
                    : { command_timeout_ms: options.commandTimeoutMs }),
                },
                { signal },
              ),
            );
            return result.ok
              ? publishCliAnalysisEvidence(
                  { ok: true, value: result.value },
                  delivery,
                )
              : projectAnalysisError(result.error);
          },
        ),
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
    options: z.object({
      commandTimeoutMs: reverseCommandTimeoutSchema,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.executeRizinCommand, async () => {
          const result = await executeWithCleanup(service, signal, () =>
            service.executeRizinCommand(
              {
                ...args,
                ...(options.commandTimeoutMs === undefined
                  ? {}
                  : { command_timeout_ms: options.commandTimeoutMs }),
              },
              { signal },
            ),
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.debugWithGdb, {
    description:
      "Run one unrestricted GDB console command in an ephemeral MI session; provide an inferior TTY so a live target can be safely detached",
    args: z.object({
      command: z
        .string()
        .min(1)
        .describe("One unrestricted GDB console command."),
    }),
    options: z.object({
      inferiorTty: z
        .string()
        .min(1)
        .describe(
          "Caller-selected durable TTY for output from a live GDB inferior.",
        ),
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.debugWithGdb, async () => {
          const delivery = {
            providerId: "gdb",
            operation: "gdb_console",
            signal,
            detail: options.detail,
            evidenceOutput: options.evidence_output,
          };
          const inputError = cliEvidenceDeliveryInputError(delivery);
          if (inputError !== undefined) return projectAnalysisError(inputError);
          if (gdbOneShotCommandMayInvalidateDetachProof(args.command))
            return projectAnalysisError(
              new AnalysisInputError("gdb_console", undefined, [
                {
                  path: ["command"],
                  reason: "invalid_value",
                  message:
                    "This command can invalidate the verified inferior output route; use the persistent GDB session workflow.",
                },
              ]),
            );
          const manager = createGdbManager(environment);
          let sessionId: string | undefined;
          const completed = await (async () => {
            try {
              const started = await manager.start(signal, {
                inferiorTty: options.inferiorTty,
              });
              if (!started.ok)
                return {
                  ok: false as const,
                  error: projectAnalysisError(started.error),
                };
              sessionId = started.value.session_id;
              const executed = await manager.execute(
                sessionId,
                args.command,
                signal,
              );
              return executed.ok
                ? { ok: true as const, value: executed.value.evidence }
                : {
                    ok: false as const,
                    error: projectAnalysisError(executed.error),
                  };
            } finally {
              let cleanupFailed = false;
              if (sessionId !== undefined) {
                try {
                  const closed = await manager.close(sessionId);
                  cleanupFailed = !closed.ok;
                  if (!closed.ok)
                    logger.error(
                      {
                        command: CLI_COMMANDS.debugWithGdb,
                        cleanup: projectAnalysisError(closed.error),
                      },
                      "GDB cleanup failed after collecting command output",
                    );
                } catch (cause) {
                  cleanupFailed = true;
                  logger.error(
                    {
                      command: CLI_COMMANDS.debugWithGdb,
                      cleanup:
                        cause instanceof Error
                          ? cause.message
                          : "Unknown cleanup failure",
                    },
                    "GDB cleanup failed after collecting command output",
                  );
                }
              }
              try {
                await manager.closeAll();
                cleanupFailed = false;
              } catch (cause) {
                cleanupFailed = true;
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
              }
              if (cleanupFailed) process.exitCode = 1;
            }
          })();
          return publishCliAnalysisEvidence(completed, delivery);
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
      inferiorTty: z
        .string()
        .min(1)
        .describe("Caller-selected Linux TTY for inferior stdout and stderr."),
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
          let sessionId: string | undefined;
          try {
            const started = await manager.start(
              {
                ...args,
                inferior_tty: options.inferiorTty,
                ...(options.backend === undefined
                  ? {}
                  : { backend: options.backend }),
              },
              signal,
            );
            if (!started.ok) return projectAnalysisError(started.error);
            sessionId = started.value.session_id;
            const executed = await manager.execute(
              started.value.session_id,
              args.command,
              signal,
            );
            return executed.ok
              ? executed.value.evidence
              : projectAnalysisError(executed.error);
          } finally {
            try {
              if (sessionId !== undefined) {
                const closed = await manager.close(sessionId);
                if (!closed.ok)
                  logger.error(
                    {
                      command: CLI_COMMANDS.debugWithRizin,
                      cleanup: projectAnalysisError(closed.error),
                    },
                    "Rizin cleanup failed after collecting command output",
                  );
              }
            } catch (cause) {
              logger.error(
                {
                  command: CLI_COMMANDS.debugWithRizin,
                  cleanup:
                    cause instanceof Error
                      ? cause.message
                      : "Unknown cleanup failure",
                },
                "Rizin cleanup failed after collecting command output",
              );
            }
            // The retained owner retries all sessions. Only its final outcome
            // establishes whether command cleanup remains incomplete.
            await manager.closeAll().catch((cause: unknown) => {
              process.exitCode = 1;
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
        }),
      ),
  });
};
