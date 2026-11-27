import type { Logger } from "pino";
import type { GhidraCheckpointSelection } from "./GhidraCheckpoint.js";
import type { BridgeMaxRequestBytes } from "../config/bridgeMaxRequestBytes.js";
import type { GhidraCancelGrace } from "../config/ghidraCancelGrace.js";
import type { GhidraCheckpointSaveWait } from "../config/ghidraCheckpointSaveWait.js";
import type { BridgeMaxReplyBytes } from "../config/bridgeMaxReplyBytes.js";
import type { Result } from "../domain/result.js";
import type { LinuxCgroupMemoryState } from "../process/LinuxCgroupMemory.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { GhidraLauncher } from "./GhidraLauncher.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";
import type { GhidraTransportKind } from "./GhidraTransport.js";
import type { NativeValueFlowLimits } from "../domain/native/nativeValueFlow.js";

/** Result of opening and authenticating one headless Ghidra session. */
export type GhidraStartResult = Result<GhidraSessionInfo, GhidraSessionError>;

/** Cancellation and deadline controls shared by authenticated requests. */
export interface GhidraRequestOptions {
  readonly decompileTimeoutSeconds?: number | null;
  /**
   * Native decompiler payload limit in MiB. Omitted leaves the session's
   * current limit, and the decompiles completed under it, unchanged; `null`
   * selects the installed Ghidra default.
   */
  readonly decompileMaxPayloadMiB?: number | null;
  /** Procedures the bridge may decompile together before this request. */
  readonly decompileReadAhead?: readonly string[];
  readonly valueFlowLimits?: NativeValueFlowLimits;
  readonly signal?: AbortSignal;
  /**
   * Asks the bridge to stop this request while its reply is still awaited.
   * The request queue sets it for interruptible operations; `signal` stays the
   * stop that abandons the reply.
   */
  readonly interrupt?: AbortSignal;
  /** Internal startup/shutdown deadline; analysis calls have no fixed deadline. */
  readonly timeoutMs?: number;
  /**
   * Ceilings admitted when the request entered the FIFO. The wire applies
   * them only when this request is written, because the queue may drain it
   * outside the caller's settings context. Omitted admits them at write time,
   * for requests the caller writes directly.
   */
  readonly limits?: GhidraAdmittedLimits;
  /**
   * Runs immediately before the wire writes a frame that passed admission.
   * A request removed while queued, or refused before that write, never runs it.
   */
  readonly onAdmitted?: () => void;
}

/** Bridge ceilings copied from the settings when one request was admitted. */
export interface GhidraAdmittedLimits {
  readonly requestLimit: BridgeMaxRequestBytes;
  readonly replyLimit: BridgeMaxReplyBytes;
}

/** Safe lifecycle telemetry for one isolated Ghidra headless process. */
export type GhidraDiagnostic =
  | {
      readonly type: "launcher-output";
      readonly stream: "stdout" | "stderr";
      readonly bytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly type: "launcher-exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "cleanup-incomplete"; readonly reason: string };

/** Dependencies and exact profile commitment for one headless Program session. */
export interface GhidraClientOptions {
  readonly launcher: GhidraLauncher;
  readonly runId?: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly existingProject?: boolean;
  readonly checkpoint?: GhidraCheckpointSelection;
  /** Bound on a checkpoint save's wait for another session; absent keeps the default. */
  readonly checkpointSaveWait?: GhidraCheckpointSaveWait;
  /** Installation host shared by runtime allocation and snapshot admission. */
  readonly platform?: NodeJS.Platform;
  readonly transport?: GhidraTransportKind;
  readonly providerVersion: string;
  readonly profileDigest: string;
  readonly expectedLanguageId?: string;
  readonly expectedCompilerSpecId?: string;
  /** Canonical `0x` image base the committed profile placed the target at. */
  readonly expectedImageBase?: string;
  readonly startupTimeoutMs?: number;
  readonly readStartupTimeoutMs?: () => number;
  /**
   * How long a cancelled read may take to answer before the session is closed
   * instead; absent keeps the default.
   */
  readonly cancelGrace?: GhidraCancelGrace;
  readonly onDiagnostic?: (event: GhidraDiagnostic) => void;
  readonly logger?: Logger;
  /**
   * Observes REA's memory cgroup around a run; defaults to the Linux cgroup v2
   * reader. A file whose close fails is handed to `retainFailedClose`.
   */
  readonly readMemoryCgroup?: (options: {
    readonly retainFailedClose: (path: string, owner: OwnedFileHandle) => void;
  }) => Promise<LinuxCgroupMemoryState | undefined>;
  /** Effective request ceiling; defaults to the configured bridge ceiling. */
  readonly bridgeMaxRequestBytes?: BridgeMaxRequestBytes;
  /** Effective reply line ceiling; defaults to the configured bridge ceiling. */
  readonly bridgeMaxReplyBytes?: BridgeMaxReplyBytes;
}
