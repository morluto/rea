import { z } from "zod";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Logger } from "pino";
import { OBJDUMP_PROVIDER_IDENTITY } from "../objdump/ObjdumpProviderIdentity.js";
import { RIZIN_PROVIDER_IDENTITY } from "../rizin/RizinProviderIdentity.js";

import { createReverseEngineeringService } from "../composition/reverseEngineering.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import { recognizeEvidence } from "../domain/evidenceValidation.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import { ok } from "../domain/result.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { OBJDUMP_ARTIFACT_OPERATIONS } from "../domain/reverseEngineering.js";
import { logCliCommand } from "../cliLogging.js";
import { registerCliCommand } from "./commandRegistry.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { CLI_COMMANDS } from "../contracts/cliCommandNames.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../contracts/reverseEngineeringToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import type { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import { gdbOneShotCommandMayInvalidateDetachProof } from "../gdb/GdbSessionManager.js";
import {
  createGdbSessionManager,
  createRizinDebugSessionManager,
} from "../composition/debuggerSessions.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  retainedDebuggerDiagnostics,
  retainedDebuggerProcessIds,
  retainedDebuggerRemediation,
} from "../process/ownedDebuggerCleanupError.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDeliveryOptions.js";
import {
  deliverCliAnalysisEvidence,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isRecord } from "../kernel/isRecord.js";

const executeWithCleanup = async (
  service: ReverseEngineeringService,
  signal: AbortSignal,
  execute: () => Promise<Result<Evidence, AnalysisError>>,
  operation: "inspect_with_objdump" | "execute_rizin_command",
) =>
  finishAnalysisCommand(
    execute,
    service,
    operation === "inspect_with_objdump"
      ? OBJDUMP_PROVIDER_IDENTITY.id
      : RIZIN_PROVIDER_IDENTITY.id,
    operation,
    signal,
    undefined,
    { recoverResolvedCleanup: cleanupOnlyCompleteEvidence },
  );

const cleanupOnlyCompleteEvidence = (
  error: AnalysisError,
): Evidence | undefined => {
  if (
    !(error instanceof AnalysisOutputError) ||
    !error.cleanupOnly ||
    error.partialObservation === undefined
  )
    return undefined;
  // Only authenticated Evidence is recovered; otherwise the error stands.
  const parsed = recognizeEvidence(error.partialObservation);
  if (!parsed.ok || parsed.value === undefined) return undefined;
  const normalized = parsed.value.normalized_result;
  return isRecord(normalized) && normalized.completion_status !== "unknown"
    ? parsed.value
    : undefined;
};

/** One-shot debugger cleanup: the retained owner's closeAll decides whether cleanup remains incomplete. */
const closeDebuggerCommandSession = async (
  manager: {
    close(sessionId: string): Promise<Result<unknown, AnalysisError>>;
    closeAll(): Promise<void>;
  },
  sessionId: string | undefined,
  providerId: string,
  operation: string,
  log: (cleanup: JsonValue | string) => void,
): Promise<void> => {
  if (sessionId !== undefined) {
    try {
      const closed = await manager.close(sessionId);
      if (!closed.ok) log(projectAnalysisError(closed.error));
    } catch (cause) {
      log(cause instanceof Error ? cause.message : "Unknown cleanup failure");
    }
  }
  try {
    await manager.closeAll();
  } catch (cause) {
    // This process is the only owner, so a caller gets the debugger to check
    // rather than a retry that no later command could perform.
    const retainedPids = retainedDebuggerProcessIds(cause);
    throw new ProviderCleanupError(
      providerId,
      sessionId === undefined ? [] : [sessionId],
      {
        reason:
          cause instanceof AggregateError
            ? cause.errors
                .map((error: unknown) => errorMessage(error))
                .join("; ")
            : errorMessage(cause),
        ...retainedDebuggerDiagnostics(cause),
      },
      {
        cause,
        operation,
        ...(retainedPids.length === 0
          ? {}
          : { remediationAction: retainedDebuggerRemediation(retainedPids) }),
      },
    );
  }
};

/** Add one-shot reverse-engineering commands using the shared service layer. */
export const registerReverseEngineeringCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  createGdbManager: (
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => ReturnType<typeof createGdbSessionManager> = createGdbSessionManager,
  createService: typeof createReverseEngineeringService = createReverseEngineeringService,
): void => {
  const service = createService(environment);
  const objdump = contractNamed(
    REVERSE_ENGINEERING_TOOL_CONTRACTS,
    "inspect_with_objdump",
  );
  const inspectWithObjdump = async (
    input: unknown,
    { signal, delivery }: ContractCommandContext,
  ) => {
    if (delivery === undefined)
      throw new Error("inspect_with_objdump delivers Evidence");
    const result = await executeWithCleanup(
      service,
      signal,
      () => service.inspectWithObjdump(input, { signal }),
      "inspect_with_objdump",
    );
    return result.ok
      ? publishCliAnalysisEvidence(result, {
          operation: "inspect_with_objdump",
          signal,
          detail: delivery.detail,
          evidenceOutput: delivery.evidenceOutput,
        })
      : result.error;
  };
  registerContractCommand(
    cli,
    logger,
    objdump,
    {
      description:
        "Inspect a local artifact using GNU-style objdump arguments and retain the selected command output as Evidence",
      inputBranches: {
        field: "operation",
        values: OBJDUMP_ARTIFACT_OPERATIONS,
      },
      positionals: ["path", "operation"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Path to the local artifact to inspect." },
        operation: { description: "GNU-style objdump operation to run." },
        symbol: {
          description:
            "Native symbol to select with the disassemble operation; the selected executable controls matching and boundaries.",
        },
        follow_debug_links: {
          description:
            "Follow local DWARF debug links. External debug-file identity is not bound to Evidence.",
        },
      },
    },
    inspectWithObjdump,
  );
  registerContractCommand(
    cli,
    logger,
    objdump,
    {
      command: CLI_COMMANDS.listObjdumpArchitectures,
      description: "Capture the selected objdump command response to -i",
      inputBranches: { field: "operation", values: ["architectures"] },
      evidenceDelivery: true,
    },
    inspectWithObjdump,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(REVERSE_ENGINEERING_TOOL_CONTRACTS, "execute_rizin_command"),
    {
      description: "Execute one Rizin command against a local artifact",
      positionals: ["path", "command"],
      fields: {
        path: { description: "Path to the local artifact to analyze." },
        command: { description: "One caller-selected Rizin command." },
      },
    },
    async (input, { signal }) =>
      projectCliAnalysisResult(
        await executeWithCleanup(
          service,
          signal,
          () => service.executeRizinCommand(input, { signal }),
          "execute_rizin_command",
        ),
      ),
  );
  registerCliCommand(
    cli,
    CLI_COMMANDS.debugWithGdb,
    {
      description:
        "Run one unrestricted GDB console command in an ephemeral MI session; provide an inferior TTY so a live target can be safely detached",
      args: z.object({
        command: z
          .string()
          .min(1)
          .describe("One unrestricted GDB console command."),
      }),
      options: z.object({
        executable: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Initial local file to hash and load without running it; command Evidence retains this initial selection.",
          ),
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
            if (inputError !== undefined)
              return projectAnalysisError(inputError);
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
            return deliverCliAnalysisEvidence({
              ...delivery,
              run: async () => {
                const started = await manager.start(signal, {
                  inferiorTty: options.inferiorTty,
                  ...(options.executable === undefined
                    ? {}
                    : { executable: options.executable }),
                });
                if (!started.ok) return started;
                sessionId = started.value.session_id;
                const executed = await manager.execute(
                  sessionId,
                  args.command,
                  signal,
                );
                return executed.ok ? ok(executed.value.evidence) : executed;
              },
              service: {
                close: () =>
                  closeDebuggerCommandSession(
                    manager,
                    sessionId,
                    "gdb",
                    "gdb_console",
                    (cleanup) =>
                      logger.error(
                        { command: CLI_COMMANDS.debugWithGdb, cleanup },
                        "GDB cleanup failed after collecting command output",
                      ),
                  ),
              },
            });
          }),
        ),
    },
    {
      operations: [{ name: "gdb_console", flags: {} }],
    },
  );
  registerCliCommand(
    cli,
    CLI_COMMANDS.debugWithRizin,
    {
      description:
        "Run one unrestricted Rizin debugger command in an ephemeral session",
      args: z.object({
        path: localPathStringSchema.describe(
          "Path to the local artifact to debug.",
        ),
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
          .describe(
            "Caller-selected Linux TTY for inferior stdin, stdout and stderr.",
          ),
        backend: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Rizin IO debugger backend name."),
      }),
      run: ({ args, options }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, CLI_COMMANDS.debugWithRizin, async () => {
            const manager = createRizinDebugSessionManager(environment);
            let sessionId: string | undefined;
            return finishAnalysisCommand(
              async () => {
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
                if (!started.ok) return started;
                sessionId = started.value.session_id;
                const executed = await manager.execute(
                  sessionId,
                  args.command,
                  signal,
                );
                return executed.ok ? ok(executed.value.evidence) : executed;
              },
              {
                close: () =>
                  closeDebuggerCommandSession(
                    manager,
                    sessionId,
                    "rizin",
                    "rizin_debug_command",
                    (cleanup) =>
                      logger.error(
                        { command: CLI_COMMANDS.debugWithRizin, cleanup },
                        "Rizin cleanup failed after collecting command output",
                      ),
                  ),
              },
              "rizin",
              "rizin_debug_command",
              signal,
            ).then(projectCliAnalysisResult);
          }),
        ),
    },
    {
      operations: [{ name: "rizin_debug_command", flags: {} }],
    },
  );
};
