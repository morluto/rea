import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import type { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import {
  fridaDeviceSelection,
  fridaRemoteConnection,
  instrumentWithFrida,
  loadFridaScript,
  startFridaSession,
} from "../application/frida/fridaContractRequests.js";
import type { CutterBridgeService } from "../cutter/CutterBridgeService.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  GDB_SESSION_TOOLS,
  RADARE2_SESSION_TOOLS,
  RIZIN_DEBUG_SESSION_TOOLS,
  unknownDebuggerSessionError,
} from "../domain/debuggerSessionErrors.js";
import type { Evidence } from "../domain/evidence.js";
import { ownedJsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import type { Radare2SessionManager } from "../radare2/Radare2SessionManager.js";
import type { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import type { ContractToolBindings } from "./contractToolBindings.js";
import type { ExternalMutationAdmission } from "./externalMutationAdmission.js";

/** Rizin debugger sessions a manager owns and the session they may change. */
export interface RizinDebugToolOptions {
  readonly manager: Pick<
    RizinDebugSessionManager,
    "start" | "execute" | "status" | "close" | "retryCleanupFailures"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** Persistent Radare2 sessions a manager owns and the session they may change. */
export interface Radare2SessionToolOptions {
  readonly manager: Pick<
    Radare2SessionManager,
    "start" | "execute" | "status" | "close" | "retryCleanupFailures"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** GDB sessions a manager owns and the session their commands may change. */
export interface GdbToolOptions {
  readonly manager: Pick<
    GdbSessionManager,
    "start" | "execute" | "status" | "close" | "retryCleanupFailures"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** The Cutter bridge and the session its commands may change. */
export interface CutterToolOptions {
  readonly service: Pick<
    CutterBridgeService,
    "listSessions" | "execute" | "retryCleanup"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

const jsonValueResult = <Error>(
  result: Result<unknown, Error>,
): Result<JsonValue, Error> =>
  result.ok ? ok(ownedJsonValueSchema.parse(result.value)) : result;

/** Bind Cutter discovery and external-mutation command tools. */
export const bindCutterTools = ({
  service,
  session,
}: CutterToolOptions): ContractToolBindings => ({
  list_cutter_sessions: {
    admission: "sdk",
    value: async (_input, { signal }) => {
      const listed = await service.listSessions({ signal });
      return listed.ok
        ? ok({ ...listed.value, sessions: [...listed.value.sessions] })
        : listed;
    },
  },
  cutter_command: {
    admission: "sdk",
    session,
    mutation: {
      kind: "evidence",
      retryCleanup: () => service.retryCleanup(),
      run: (input, signal) => service.execute(input, { signal }),
    },
  },
});

/** Bind Rizin debugger session lifecycle and external-mutation command tools. */
export const bindRizinDebugTools = ({
  manager,
  session,
}: RizinDebugToolOptions): ContractToolBindings => {
  const retryCleanup = () => manager.retryCleanupFailures();
  return {
    start_rizin_debug_session: {
      admission: "sdk",
      session,
      mutation: {
        kind: "value",
        retryCleanup,
        run: async (input, signal) => {
          const started = await manager.start(
            {
              path: input.path,
              inferior_tty: input.inferior_tty,
              ...(input.backend === undefined
                ? {}
                : { backend: input.backend }),
            },
            signal,
          );
          return started.ok
            ? ok({
                value: started.value,
                retained: { session_id: started.value.session_id },
              })
            : started;
        },
      },
    },
    rizin_debug_command: {
      admission: "sdk",
      session,
      mutation: {
        kind: "evidence",
        retryCleanup,
        run: async (input, signal) => {
          const executed = await manager.execute(
            input.session_id,
            input.command,
            signal,
          );
          return executed.ok ? ok(executed.value.evidence) : executed;
        },
      },
    },
    rizin_debug_session_status: {
      admission: "sdk",
      value: async (input) => {
        const status = manager.status(input.session_id);
        return status === undefined
          ? err(
              unknownDebuggerSessionError(
                RIZIN_DEBUG_SESSION_TOOLS,
                "rizin_debug_session_status",
              ),
            )
          : ok({ ...status, recent_output: [...status.recent_output] });
      },
    },
    close_rizin_debug_session: {
      admission: "sdk",
      session,
      mutation: {
        kind: "owned-cleanup",
        resource: (input) => input.session_id,
        run: (input) => manager.close(input.session_id),
      },
    },
  };
};

/** Bind Radare2 session lifecycle and external-mutation command tools. */
export const bindRadare2Tools = ({
  manager,
  session,
}: Radare2SessionToolOptions): ContractToolBindings => {
  const retryCleanup = () => manager.retryCleanupFailures();
  return {
    start_radare2_session: {
      admission: "sdk",
      session,
      mutation: {
        kind: "value",
        retryCleanup,
        // The engine starts before admission retires the previously open
        // target; a cancellation during that retirement must close it, or it
        // keeps running without the caller ever receiving its identifier.
        release: async (retained) => {
          const sessionId = retained.session_id;
          if (sessionId === undefined) return ok(null);
          const closed = await manager.close(sessionId);
          return closed.ok ? ok(null) : closed;
        },
        run: async (input, signal) => {
          const started = await manager.start({ path: input.path }, signal);
          if (!started.ok) return started;
          const observed: Array<{
            readonly argument: string;
            readonly observation: Evidence;
          }> = [];
          for (const [index, initialCommand] of (
            input.initial_commands ?? []
          ).entries()) {
            const executed = await manager.execute(
              started.value.session_id,
              initialCommand,
              signal,
            );
            if (
              executed.ok &&
              !executed.value.result.command_error &&
              executed.value.result.completion_status === "complete"
            ) {
              // Keep each completed command's observation: a later failure
              // must not make the caller repeat work that already succeeded.
              observed.push({
                argument: `initial_commands[${index}]`,
                observation: executed.value.evidence,
              });
              continue;
            }
            const closed = await manager
              .close(started.value.session_id)
              .catch(() => undefined);
            const failure = executed.ok
              ? new AnalysisOutputError(
                  "start_radare2_session",
                  executed.value.result.completion_status === "unknown"
                    ? `An initial Radare2 command could not complete (output or frame limit reached): ${initialCommand}`
                    : `An initial Radare2 command reported an error: ${executed.value.result.command_logs.map((log) => log.message).join("; ") || executed.value.result.command}`,
                  { partialObservation: executed.value.evidence },
                )
              : executed.error;
            for (const kept of observed)
              failure.retainArgumentObservation(
                kept.argument,
                kept.observation,
              );
            return closed === undefined || closed.ok
              ? err(failure)
              : err(
                  // A failed close keeps the engine owned; binding the
                  // manager-retained failure lets a verified retry clear
                  // this wrapper's cleanup status too.
                  analysisErrorWithCleanupDependencies(
                    failure,
                    closed.error,
                    "start_radare2_session",
                  ),
                );
          }
          return ok({
            value: started.value,
            retained: { session_id: started.value.session_id },
          });
        },
      },
    },
    radare2_command: {
      admission: "sdk",
      session,
      mutation: {
        kind: "evidence",
        retryCleanup,
        run: async (input, signal) => {
          const executed = await manager.execute(
            input.session_id,
            input.command,
            signal,
          );
          return executed.ok ? ok(executed.value.evidence) : executed;
        },
      },
    },
    radare2_session_status: {
      admission: "sdk",
      value: async (input) => {
        const status = manager.status(input.session_id);
        return status === undefined
          ? err(
              unknownDebuggerSessionError(
                RADARE2_SESSION_TOOLS,
                "radare2_session_status",
              ),
            )
          : ok({ ...status, recent_output: [...status.recent_output] });
      },
    },
    close_radare2_session: {
      admission: "sdk",
      session,
      mutation: {
        kind: "owned-cleanup",
        resource: (input) => input.session_id,
        run: (input) => manager.close(input.session_id),
      },
    },
  };
};

/** Bind GDB session lifecycle and external-mutation console tools. */
export const bindGdbTools = ({
  manager,
  session,
}: GdbToolOptions): ContractToolBindings => ({
  start_gdb_session: {
    admission: "sdk",
    value: (input, { signal }) =>
      manager.start(signal, {
        ...(input.inferior_tty === undefined
          ? {}
          : { inferiorTty: input.inferior_tty }),
        ...(input.executable === undefined
          ? {}
          : { executable: input.executable }),
      }),
  },
  gdb_console: {
    admission: "sdk",
    session,
    mutation: {
      kind: "evidence",
      detail: "delivery",
      retryCleanup: () => manager.retryCleanupFailures(),
      run: async (input, signal) => {
        const executed = await manager.execute(
          input.session_id,
          input.command,
          signal,
        );
        return executed.ok ? ok(executed.value.evidence) : executed;
      },
    },
  },
  gdb_session_status: {
    admission: "sdk",
    value: async (input) => {
      const status = manager.status(input.session_id);
      return status === undefined
        ? err(
            unknownDebuggerSessionError(
              GDB_SESSION_TOOLS,
              "gdb_session_status",
            ),
          )
        : ok({ ...status, recent_mi_records: [...status.recent_mi_records] });
    },
  },
  close_gdb_session: {
    admission: "sdk",
    session,
    mutation: {
      kind: "owned-cleanup",
      resource: (input) => input.session_id,
      run: (input) => manager.close(input.session_id),
    },
  },
});

/** Bind Frida dynamic instrumentation tools outside session analysis admission. */
export const bindFridaTools = (
  service: FridaInstrumentationService,
  retention: AnalysisViewRetention,
): ContractToolBindings => ({
  list_frida_devices: {
    admission: "sdk",
    value: async (input) =>
      jsonValueResult(
        await service.listDevices(fridaRemoteConnection(input.remote)),
      ),
  },
  list_frida_processes: {
    admission: "sdk",
    value: async (input) =>
      jsonValueResult(
        await service.listProcesses(fridaDeviceSelection(input), {
          limit: input.limit,
          offset: input.offset,
        }),
      ),
  },
  start_frida_session: {
    admission: "sdk",
    value: async (input, { signal }) =>
      jsonValueResult(await startFridaSession(service, input, signal)),
  },
  load_frida_script: {
    admission: "sdk",
    run: (input, { signal }) => loadFridaScript(service, input, signal),
  },
  resume_frida_session: {
    admission: "sdk",
    value: async (input, { signal }) => {
      const resumed = await service.resumeSession(input.session_id, signal);
      return resumed.ok ? ok({ state: "running" }) : resumed;
    },
  },
  unload_frida_script: {
    admission: "sdk",
    value: async (input, { signal }) => {
      const unloaded = await service.unloadScript(
        input.session_id,
        input.script_id,
        signal,
      );
      return unloaded.ok ? ok({ unloaded: true }) : unloaded;
    },
  },
  frida_session_status: {
    admission: "sdk",
    run: async (input) => service.inspectStatus(input, retention),
  },
  close_frida_session: {
    admission: "sdk",
    value: async (input) => {
      const closed = await service.closeSession(input.session_id);
      return closed.ok ? ok({ target_state: "unknown" }) : closed;
    },
  },
  instrument_with_frida: {
    admission: "sdk",
    run: async (input, { signal }) => {
      const instrumented = await instrumentWithFrida(service, input, signal);
      return instrumented.ok ? ok(instrumented.value.evidence) : instrumented;
    },
  },
});
