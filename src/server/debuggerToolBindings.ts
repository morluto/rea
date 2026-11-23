import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewService.js";
import type { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import {
  fridaDeviceSelection,
  fridaRemoteConnection,
  instrumentWithFrida,
  loadFridaScript,
  startFridaSession,
} from "../application/frida/fridaContractRequests.js";
import type { CutterBridgeService } from "../cutter/CutterBridgeService.js";
import {
  GDB_SESSION_TOOLS,
  RIZIN_DEBUG_SESSION_TOOLS,
  unknownDebuggerSessionError,
} from "../domain/debuggerSessionErrors.js";
import { ownedJsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { GdbSessionManager } from "../gdb/GdbSessionManager.js";
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
