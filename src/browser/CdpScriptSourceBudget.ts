import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { Budget } from "../domain/budget.js";
import {
  noRuntimeOverrideSentence,
  selectedCdpCommandTimeoutMs,
} from "../domain/browserDeadline.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

const MIB = 1024 * 1024;

export const CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON = `script source was omitted because the aggregate ${String(WEB_RUNTIME_LIMITS.sourceBytes)}-byte (${String(WEB_RUNTIME_LIMITS.sourceBytes / MIB)} MiB) source budget was exhausted. ${noRuntimeOverrideSentence("That source budget stays fixed.", "command_timeout_ms")}`;

/** Name command_timeout_ms on a passive script-source collection miss. */
export const cdpScriptSourceDeadlineOmissionReason = (
  timeoutMs: number,
): string =>
  `script source was omitted because the ${String(timeoutMs)} ms command_timeout_ms source collection deadline elapsed (deadlineExpired). This is not the caller observation window. ${noRuntimeOverrideSentence(`The ${String(WEB_RUNTIME_LIMITS.sourceBytes)}-byte source budget stays fixed.`, "command_timeout_ms")}`;

/** Shared admission for source text retained from passive CDP script reads. */
export class CdpScriptSourceBudget {
  #active:
    | { readonly deadline: ProviderStartupDeadline; readonly startedAt: number }
    | undefined;
  #remainingMs: number;
  readonly #retained = new Budget(WEB_RUNTIME_LIMITS.sourceBytes);

  constructor(
    private readonly callerSignal?: AbortSignal,
    readonly commandTimeoutMs: number = selectedCdpCommandTimeoutMs(undefined),
  ) {
    this.#remainingMs = commandTimeoutMs;
    this.beginCollection();
  }

  /** A streaming source queue spends its remaining allowance only while busy. */
  beginCollection(): void {
    if (this.#active !== undefined || this.#remainingMs === 0) return;
    this.#active = {
      startedAt: performance.now(),
      deadline: new ProviderStartupDeadline(
        this.#remainingMs,
        this.callerSignal,
      ),
    };
  }

  get signal(): AbortSignal | undefined {
    return this.#active?.deadline.signal;
  }

  get timedOut(): boolean {
    return (
      this.#remainingMs === 0 ||
      this.#active?.deadline.interruption === "timeout"
    );
  }

  /** The CDP response timer can fire just before the collection timer. Its
   * full command allowance is at least the remaining collection allowance. */
  deadlineFailed(cause: unknown): boolean {
    if (
      cause instanceof BrowserObservationError &&
      cause.reason === "timeout"
    ) {
      this.#remainingMs = 0;
      return true;
    }
    return this.timedOut && cause instanceof AnalysisCancelledError;
  }

  /** Admit exact UTF-8 source bytes before building or retaining its artifact. */
  admit(text: string): boolean {
    return this.#retained.tryCharge(Buffer.byteLength(text, "utf8"));
  }

  endCollection(): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#remainingMs = this.timedOut
      ? 0
      : Math.max(0, this.#remainingMs - (performance.now() - active.startedAt));
    active.deadline.dispose();
    this.#active = undefined;
  }
}
