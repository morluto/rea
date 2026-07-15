import type { Logger } from "../logger.js";
import type { Result } from "../domain/result.js";
import type { GhidraLauncher } from "./GhidraLauncher.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";

/** Result of opening and authenticating one headless Ghidra session. */
export type GhidraStartResult = Result<GhidraSessionInfo, GhidraSessionError>;

/** Cancellation and deadline controls shared by authenticated requests. */
export interface GhidraRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Safe lifecycle telemetry for one isolated Ghidra headless process. */
export type GhidraDiagnostic =
  | {
      readonly type: "launcher-output";
      readonly stream: "stdout" | "stderr";
      readonly bytes: number;
      readonly totalBytes: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: "launcher-exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "cleanup-incomplete"; readonly reason: string };

/** Dependencies and exact profile commitment for one headless import. */
export interface GhidraClientOptions {
  readonly launcher: GhidraLauncher;
  readonly targetPath: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly onDiagnostic?: (event: GhidraDiagnostic) => void;
  readonly logger?: Logger;
}
