import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { Result } from "../../domain/result.js";

export interface FridaRemoteConnection {
  readonly address: string;
  readonly token?: string;
  readonly certificate?: string;
  readonly origin?: string;
  readonly keepaliveInterval?: number;
}

export interface FridaDeviceSelector {
  readonly deviceId?: string;
  readonly remote?: FridaRemoteConnection;
}

export interface FridaDeviceObservation {
  readonly deviceId: string;
  readonly name: string;
  readonly type: string;
}

export interface FridaProcessObservation {
  readonly pid: number;
  readonly name: string;
  readonly identifier: string | null;
}

export type StartFridaSessionInput = FridaDeviceSelector &
  (
    | { readonly mode: "attach"; readonly pid: number }
    | {
        readonly mode: "spawn";
        readonly program: string;
        readonly argv?: readonly string[];
      }
  );

export type FridaScriptSource =
  | { readonly sourceKind: "inline"; readonly source: string }
  | { readonly sourceKind: "file"; readonly path: string };

export interface FridaSessionObservation {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly target: string;
  readonly pid: number;
  readonly mode: "attach" | "spawn";
  readonly state: "paused" | "running" | "detached";
}

export interface FridaScriptObservation {
  readonly scriptId: string;
  readonly sourceKind: "inline" | "file";
  readonly sourcePath: string | null;
  readonly sourceSha256: string;
  readonly messages: readonly JsonValue[];
  readonly messagesTruncated: boolean;
}

export interface FridaSessionStatus extends FridaSessionObservation {
  readonly scripts: readonly {
    readonly scriptId: string;
    readonly name: string;
  }[];
  readonly messages: readonly JsonValue[];
  readonly messagesTruncated: boolean;
}

/** Shared application boundary for Frida runtime instrumentation workflows. */
export interface FridaInstrumentationPort {
  listDevices(remote?: FridaRemoteConnection): Promise<
    Result<
      {
        readonly devices: readonly FridaDeviceObservation[];
        readonly cleanupError: string | null;
      },
      AnalysisError
    >
  >;
  listProcesses(selector: FridaDeviceSelector): Promise<
    Result<
      {
        readonly deviceId: string;
        readonly processes: readonly FridaProcessObservation[];
        readonly cleanupError: string | null;
      },
      AnalysisError
    >
  >;
  startSession(
    input: StartFridaSessionInput,
  ): Promise<Result<FridaSessionObservation, AnalysisError>>;
  loadScript(
    sessionId: string,
    source: FridaScriptSource,
  ): Promise<Result<FridaScriptObservation, AnalysisError>>;
  resumeSession(sessionId: string): Promise<Result<null, AnalysisError>>;
  unloadScript(
    sessionId: string,
    scriptId: string,
  ): Promise<Result<null, AnalysisError>>;
  status(sessionId: string): FridaSessionStatus | undefined;
  closeSession(sessionId: string): Promise<Result<null, AnalysisError>>;
  closeAll(): Promise<void>;
}
