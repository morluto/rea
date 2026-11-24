import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  FridaCapturePolicy,
  FridaCapturePolicyInput,
} from "../../domain/fridaCapturePolicy.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { FridaInstrumentationService } from "./FridaInstrumentationService.js";
import type {
  FridaDeviceSelector,
  FridaRemoteConnection,
  FridaScriptSource,
  StartFridaSessionInput,
} from "../../ports/frida/FridaInstrumentationPort.js";

/** A Frida contract's `remote` member, as its input schema admits it. */
export interface FridaRemoteInput {
  readonly address: string;
  readonly token?: string | undefined;
  readonly certificate?: string | undefined;
  readonly origin?: string | undefined;
  readonly keepalive_interval?: number | undefined;
}

/** The device fields a Frida contract input selects. */
export interface FridaDeviceInput {
  readonly device_id?: string | undefined;
  readonly remote?: FridaRemoteInput | undefined;
}

/** The target fields of a session-starting Frida contract input. */
export interface FridaSessionStartInput extends FridaDeviceInput {
  readonly mode: "attach" | "spawn";
  readonly capture_limits?: FridaCapturePolicyInput | undefined;
  readonly pid?: number | undefined;
  readonly program?: string | undefined;
  readonly argv?: readonly string[] | undefined;
}

/** The script fields of a Frida contract input. */
export interface FridaScriptInput {
  readonly source_kind: "inline" | "file";
  readonly source?: string | undefined;
  readonly path?: string | undefined;
}

/** The remote connection a contract `remote` member selects. */
export const fridaRemoteConnection = (
  input: FridaRemoteInput | undefined,
): FridaRemoteConnection | undefined =>
  input === undefined
    ? undefined
    : {
        address: input.address,
        ...(input.token === undefined ? {} : { token: input.token }),
        ...(input.certificate === undefined
          ? {}
          : { certificate: input.certificate }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.keepalive_interval === undefined
          ? {}
          : { keepaliveInterval: input.keepalive_interval }),
      };

/** The device a contract input selects; the provider defaults to `local`. */
export const fridaDeviceSelection = (
  input: FridaDeviceInput,
): FridaDeviceSelector => {
  const remote = fridaRemoteConnection(input.remote);
  return {
    ...(input.device_id === undefined ? {} : { deviceId: input.device_id }),
    ...(remote === undefined ? {} : { remote }),
  };
};

/**
 * The session a contract input starts, or undefined when its target fields
 * do not match its mode. The contract's own rules refuse that combination.
 */
export const fridaSessionStart = (
  input: FridaSessionStartInput,
): StartFridaSessionInput | undefined => {
  const selected = {
    ...(input.capture_limits === undefined
      ? {}
      : { captureLimits: input.capture_limits }),
    ...fridaDeviceSelection(input),
  };
  if (input.mode === "attach")
    return input.pid === undefined
      ? undefined
      : { ...selected, mode: "attach", pid: input.pid };
  return input.program === undefined
    ? undefined
    : {
        ...selected,
        mode: "spawn",
        program: input.program,
        ...(input.argv === undefined ? {} : { argv: input.argv }),
      };
};

/** The script a contract input loads, or undefined when its fields disagree. */
export const fridaScriptSource = (
  input: FridaScriptInput,
): FridaScriptSource | undefined =>
  input.source_kind === "inline"
    ? input.source === undefined
      ? undefined
      : { sourceKind: "inline", source: input.source }
    : input.path === undefined
      ? undefined
      : { sourceKind: "file", path: input.path };

/** A parsed `instrument_with_frida` input. */
export interface FridaInstrumentInput
  extends FridaSessionStartInput, FridaScriptInput {
  readonly duration_ms: number;
}

/**
 * Run one instrument_with_frida request through the service. A target or
 * script that does not match its mode or source kind is refused before any
 * device is selected.
 */
export const instrumentWithFrida = (
  service: Pick<FridaInstrumentationService, "instrument">,
  input: FridaInstrumentInput,
  signal: AbortSignal | undefined,
): ReturnType<FridaInstrumentationService["instrument"]> => {
  const session = fridaSessionStart(input);
  const source = fridaScriptSource(input);
  return session === undefined || source === undefined
    ? Promise.resolve(err(new AnalysisInputError("instrument_with_frida")))
    : service.instrument(
        { ...session, source, durationMs: input.duration_ms },
        signal,
      );
};

/** The session start_frida_session reports. */
export interface FridaSessionOutput {
  readonly session_id: string;
  readonly capture_limits?: FridaCapturePolicy;
  readonly device_id: string;
  readonly target: string;
  readonly pid: number;
  readonly mode: "attach" | "spawn";
  readonly state: "paused" | "running" | "detached";
}

/**
 * Run one start_frida_session request and report the session it started. A
 * target that does not match its mode is refused before any device is
 * selected.
 */
export const startFridaSession = async (
  service: Pick<FridaInstrumentationService, "startSession">,
  input: FridaSessionStartInput,
  signal: AbortSignal | undefined,
): Promise<Result<FridaSessionOutput, AnalysisError>> => {
  const request = fridaSessionStart(input);
  if (request === undefined)
    return err(new AnalysisInputError("start_frida_session"));
  const started = await service.startSession(request, signal);
  if (!started.ok) return started;
  const session = started.value;
  return ok({
    session_id: session.sessionId,
    ...(session.captureLimits === undefined
      ? {}
      : { capture_limits: session.captureLimits }),
    device_id: session.deviceId,
    target: session.target,
    pid: session.pid,
    mode: session.mode,
    state: session.state,
  });
};

/** Run one load_frida_script request against its session. */
export const loadFridaScript = (
  service: Pick<FridaInstrumentationService, "loadScript">,
  input: FridaScriptInput & { readonly session_id: string },
  signal: AbortSignal | undefined,
): ReturnType<FridaInstrumentationService["loadScript"]> => {
  const source = fridaScriptSource(input);
  return source === undefined
    ? Promise.resolve(err(new AnalysisInputError("load_frida_script")))
    : service.loadScript(input.session_id, source, signal);
};
