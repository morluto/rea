import { setTimeout as delay } from "node:timers/promises";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../../domain/jsonValue.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  FridaDeviceSelector,
  FridaInstrumentationPort,
  FridaRemoteConnection,
  FridaScriptObservation,
  FridaScriptSource,
  FridaSessionObservation,
  FridaSessionStatus,
  StartFridaSessionInput,
} from "./FridaInstrumentationPort.js";

/** Shared CLI/MCP workflows for Frida's device and instrumentation operations. */
export class FridaInstrumentationService {
  readonly #provider: FridaInstrumentationPort;

  constructor(provider: FridaInstrumentationPort) {
    this.#provider = provider;
  }

  listDevices(remote?: FridaRemoteConnection) {
    return this.#provider.listDevices(remote);
  }

  listProcesses(selector: FridaDeviceSelector) {
    return this.#provider.listProcesses(selector);
  }

  async startSession(input: StartFridaSessionInput, signal?: AbortSignal) {
    return this.#startSession(input, signal, "start_frida_session");
  }

  async #startSession(
    input: StartFridaSessionInput,
    signal: AbortSignal | undefined,
    operation: string,
  ) {
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, (signal.reason === undefined ? {} : { cause: signal.reason })),
      );
    const started = await this.#provider.startSession(input);
    if (!started.ok || !signal?.aborted) return started;
    return this.#cancelSession(operation, started.value, input, signal.reason);
  }

  async #cancelSession(
    operation: string,
    session: FridaSessionObservation,
    input: StartFridaSessionInput,
    cause: unknown,
    loaded?: FridaScriptObservation,
  ): Promise<Result<never, AnalysisError>> {
    const status = this.#provider.status(session.sessionId);
    const observation = status ?? {
      ...session,
      scripts: [],
      messages: loaded?.messages ?? [],
      messagesTruncated: loaded?.messagesTruncated ?? false,
    };
    const closed = await this.#provider.closeSession(session.sessionId);
    const partialObservation = fridaEvidence(
      operation,
      {
        ...sessionStatusOutput(observation),
        ...(loaded === undefined
          ? {}
          : {
              source_kind: loaded.sourceKind,
              source_path: loaded.sourcePath,
              source_sha256: loaded.sourceSha256,
            }),
        cleanup_error: closed.ok ? null : closed.error.message,
        target_resume_observed:
          observation.mode === "spawn" && observation.state === "running",
        instrumentation_cleanup: closed.ok
          ? "released"
          : "incomplete_or_unknown",
        target_liveness_after_cleanup: "unknown",
      },
      fridaParameters(session.sessionId, input, session.deviceId),
    );
    return err(
      new AnalysisCancelledError(operation, {
        ...(cause === undefined ? {} : { cause }),
        partialObservation,
        ...(closed.ok
          ? {}
          : {
              cleanup: {
                reason: closed.error.message,
                resources: [session.sessionId],
              },
            }),
      }),
    );
  }

  async loadScript(
    sessionId: string,
    source: FridaScriptSource,
  ): Promise<Result<Evidence, AnalysisError>> {
    const loaded = await this.#provider.loadScript(sessionId, source);
    return loaded.ok
      ? ok(
          fridaEvidence("load_frida_script", scriptOutput(loaded.value), {
            session_id: sessionId,
          }),
        )
      : loaded;
  }

  resumeSession(sessionId: string) {
    return this.#provider.resumeSession(sessionId);
  }

  unloadScript(sessionId: string, scriptId: string) {
    return this.#provider.unloadScript(sessionId, scriptId);
  }

  status(sessionId: string): FridaSessionStatus | undefined {
    return this.#provider.status(sessionId);
  }

  statusEvidence(sessionId: string): Evidence | undefined {
    const status = this.#provider.status(sessionId);
    return status === undefined
      ? undefined
      : fridaEvidence("frida_session_status", sessionStatusOutput(status), {
          session_id: sessionId,
        });
  }

  async instrument(
    input: StartFridaSessionInput & {
      readonly source: FridaScriptSource;
      readonly durationMs: number;
    },
    signal?: AbortSignal,
  ): Promise<
    Result<
      { readonly evidence: Evidence; readonly cleanupError: string | null },
      AnalysisError
    >
  > {
    const started = await this.#startSession(
      input,
      signal,
      "instrument_with_frida",
    );
    if (!started.ok) return started;
    if (signal?.aborted)
      return this.#cancelSession(
        "instrument_with_frida",
        started.value,
        input,
        signal.reason,
      );
    const loaded = await this.#provider.loadScript(
      started.value.sessionId,
      input.source,
    );
    if (signal?.aborted)
      return this.#cancelSession(
        "instrument_with_frida",
        started.value,
        input,
        signal.reason,
        loaded.ok ? loaded.value : undefined,
      );
    if (!loaded.ok) {
      const closed = await this.#provider.closeSession(started.value.sessionId);
      return closed.ok
        ? err(withRecoveredCleanup(loaded.error))
        : err(
            withCleanupFailure(
              loaded.error,
              closed.error.message,
              started.value.sessionId,
            ),
          );
    }
    if (started.value.mode === "spawn") {
      const resumed = await this.#provider.resumeSession(
        started.value.sessionId,
      );
      if (signal?.aborted)
        return this.#cancelSession(
          "instrument_with_frida",
          started.value,
          input,
          signal.reason,
          loaded.value,
        );
      if (!resumed.ok) {
        const closed = await this.#provider.closeSession(
          started.value.sessionId,
        );
        return closed.ok
          ? resumed
          : err(
              withCleanupFailure(
                resumed.error,
                closed.error.message,
                started.value.sessionId,
              ),
            );
      }
    }
    try {
      await delay(input.durationMs, undefined, { signal });
    } catch (cause: unknown) {
      return this.#cancelSession(
        "instrument_with_frida",
        started.value,
        input,
        cause,
        loaded.value,
      );
    }
    if (signal?.aborted)
      return this.#cancelSession(
        "instrument_with_frida",
        started.value,
        input,
        signal.reason,
        loaded.value,
      );
    const status = this.#provider.status(started.value.sessionId);
    const observation = status ?? {
      ...started.value,
      scripts: [],
      messages: loaded.value.messages,
      messagesTruncated: loaded.value.messagesTruncated,
    };
    const closed = await this.#provider.closeSession(started.value.sessionId);
    const cleanupError = closed.ok ? null : closed.error.message;
    const evidence = fridaEvidence(
      "instrument_with_frida",
      {
        ...sessionStatusOutput(observation),
        source_kind: loaded.value.sourceKind,
        source_path: loaded.value.sourcePath,
        source_sha256: loaded.value.sourceSha256,
        cleanup_error: cleanupError,
      },
      fridaParameters(started.value.sessionId, input, started.value.deviceId),
    );
    return ok({
      evidence,
      cleanupError,
    });
  }

  closeSession(sessionId: string) {
    return this.#provider.closeSession(sessionId);
  }

  closeAll(): Promise<void> {
    return this.#provider.closeAll();
  }
}

const fridaEvidence = (
  operation: string,
  result: unknown,
  parameters: unknown,
): Evidence =>
  createEvidence(
    undefined,
    { id: "frida", name: "Frida", version: null },
    {
      predicateType: "rea.frida.instrumentation-observation",
      operation,
      parameters: jsonObjectSchema.parse(parameters),
      result: jsonValueSchema.parse(result),
      confidence: "observed",
      authority: "external-service",
      environment: null,
      limitations: [
        "The target operating system and architecture were not reported by this observation.",
      ],
    },
  );

const fridaParameters = (
  sessionId: string,
  input: StartFridaSessionInput,
  deviceId: string,
) => ({
  session_id: sessionId,
  device_id: deviceId,
  ...(input.remote === undefined
    ? {}
    : {
        remote: {
          address: input.remote.address,
          ...(input.remote.origin === undefined
            ? {}
            : { origin: input.remote.origin }),
          ...(input.remote.keepaliveInterval === undefined
            ? {}
            : { keepalive_interval: input.remote.keepaliveInterval }),
        },
      }),
  mode: input.mode,
  ...(input.mode === "attach"
    ? { pid: input.pid }
    : {
        program: input.program,
        ...(input.argv === undefined ? {} : { argv: input.argv }),
      }),
});

const withCleanupFailure = (
  original: AnalysisError,
  cleanupReason: string,
  sessionId: string,
): AnalysisError =>
  new AnalysisCapabilityUnavailableError(
    "frida",
    "instrument_with_frida",
    `${original.message}; cleanup failed: ${cleanupReason}`,
    {
      cause: original,
      cleanup: {
        reason: cleanupReason,
        resources: [sessionId],
      },
    },
  );

const withRecoveredCleanup = (error: AnalysisError): AnalysisError =>
  error instanceof AnalysisCapabilityUnavailableError && error.cleanupIncomplete
    ? new AnalysisCapabilityUnavailableError(
        error.providerId,
        error.operation,
        error.reason,
        {
          cause: error.cause,
          ...(error.userMessage === undefined
            ? {}
            : { userMessage: error.userMessage }),
        },
      )
    : error;

const scriptOutput = (script: FridaScriptObservation) => ({
  script_id: script.scriptId,
  source_kind: script.sourceKind,
  source_path: script.sourcePath,
  source_sha256: script.sourceSha256,
  messages: script.messages,
  messages_truncated: script.messagesTruncated,
});

const sessionStatusOutput = (status: FridaSessionStatus) => ({
  session_id: status.sessionId,
  state: status.state,
  target: status.target,
  pid: status.pid,
  scripts: status.scripts.map((script) => ({
    script_id: script.scriptId,
    name: script.name,
  })),
  messages: status.messages,
  messages_truncated: status.messagesTruncated,
});
