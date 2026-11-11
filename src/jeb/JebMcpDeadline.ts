import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { currentAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { DEFAULT_JEB_MCP_TIMEOUT_MS } from "../domain/analysisResourceLimits.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

/** Which JEB MCP phase consumed `REA_JEB_MCP_TIMEOUT_MS`. */
export type JebMcpDeadlinePhase = "discovery" | "tools/call";

/** Where the JEB deadline in force was selected. */
export type JebMcpTimeoutSource = "default" | "setting" | "runtime";

/**
 * Runtime override, then the launch setting, then the built-in default.
 * An invalid launch value is omitted by the caller so this can still select
 * the override.
 */
export const selectedJebMcpTimeout = (
  launchMs: number | undefined,
): { readonly ms: number; readonly source: JebMcpTimeoutSource } => {
  const override =
    currentAnalysisOperationSnapshot()?.overrides["jeb.mcp_timeout_ms"];
  if (override !== undefined) return { ms: override, source: "runtime" };
  if (launchMs !== undefined) return { ms: launchMs, source: "setting" };
  return { ms: DEFAULT_JEB_MCP_TIMEOUT_MS, source: "default" };
};

/** Name the deadline that both JEB phases share. */
export const jebMcpTimeoutGuidance = (
  phase: JebMcpDeadlinePhase,
  timeoutMs: number,
  source: JebMcpTimeoutSource,
) => {
  const limit = analysisSettingLimit("jeb.mcp_timeout_ms", timeoutMs, source);
  return {
    userMessage: `This request reached REA's configured JEB ${phase === "discovery" ? "catalog discovery" : phase} deadline of ${String(timeoutMs)} ms (deadlineExpired).`,
    remediationAction: `jeb.mcp_timeout_ms is ${String(timeoutMs)} ms (source ${source}; default ${String(DEFAULT_JEB_MCP_TIMEOUT_MS)} ms, floor ${String(limit.minimum)} ms, maximum ${String(limit.maximum)} ms). It can be changed at runtime with update_analysis_settings. The launch seed is REA_JEB_MCP_TIMEOUT_MS. The same setting raises catalog discovery and each tools/call. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
    limit,
  };
};

/** SDK 2.3.1 preserves an SdkError abort reason by identity. */
export class JebMcpDeadline {
  readonly #deadline: ProviderStartupDeadline;
  readonly #controller = new AbortController();
  readonly #interruption = new SdkError(
    SdkErrorCode.RequestTimeout,
    "JEB MCP interrupted",
  );
  readonly #onAbort = (): void => this.#controller.abort(this.#interruption);

  constructor(
    readonly timeoutMs: number,
    signal?: AbortSignal,
    readonly phase: JebMcpDeadlinePhase = "tools/call",
    readonly source: JebMcpTimeoutSource = "default",
  ) {
    this.#deadline = new ProviderStartupDeadline(timeoutMs, signal);
    if (this.#deadline.signal.aborted) this.#onAbort();
    else
      this.#deadline.signal.addEventListener("abort", this.#onAbort, {
        once: true,
      });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  remainingMs(): number {
    return this.#deadline.remainingMs();
  }

  /** Classify only the rejection produced by this deadline's exact abort. */
  failure(operation: string, cause: unknown): unknown {
    if (cause === this.#interruption) {
      return this.#deadline.interruption === "timeout"
        ? new AnalysisTimeoutError(operation, this.timeoutMs, {
            cause: this.#deadline.signal.reason,
            ...jebMcpTimeoutGuidance(this.phase, this.timeoutMs, this.source),
          })
        : new AnalysisCancelledError(operation, {
            cause: this.#deadline.signal.reason,
          });
    }
    if (cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout)
      return new AnalysisTimeoutError(operation, this.timeoutMs, {
        cause,
        ...jebMcpTimeoutGuidance(this.phase, this.timeoutMs, this.source),
      });
    return cause;
  }

  dispose(): void {
    this.#deadline.signal.removeEventListener("abort", this.#onAbort);
    this.#deadline.dispose();
  }
}
