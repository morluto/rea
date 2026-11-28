import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisTimeoutError,
  OwnerCancellation,
} from "../../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  cdpCleanupGraceExpired,
  cdpCommandDeadlineRecovery,
  selectedCdpCommandTimeoutMs,
} from "../../domain/browserDeadline.js";
import { isCdpSessionNotFoundRejection } from "../CdpCommandRejection.js";
import { CdpTargetSessionOwner } from "../CdpTargetSessionOwner.js";
import { classifyCdpFrameUrl } from "../CdpCaptureDocuments.js";
import type { CdpFrameTree } from "../protocol/CdpFrameTree.js";
import type {
  CdpDomainWith,
  CdpCommand,
  CdpCommandParams,
  CdpCommandResult,
} from "../protocol/CdpCommands.js";
import {
  WEB_RUNTIME_LIMITS,
  type webRuntimeTargetSchema,
} from "../../domain/webRuntime.js";
import type { z } from "zod";
import { authorizeCdpTarget } from "../CdpAuthorizedTarget.js";
import { authorizedMainFrame } from "../CdpAuthorizedMainFrame.js";
import { cdpOriginScopeRefusal } from "../CdpOriginScopeError.js";
import {
  discoverCdpEndpoint,
  type CdpEndpointDiscovery,
} from "../CdpEndpoint.js";
import {
  cdpRootDocument,
  openCdpTargetSession,
  type CdpTargetSession,
} from "../CdpTargetSession.js";
import { CdpTargetDocument } from "../CdpTargetDocument.js";
import { errorMessage } from "../../kernel/errorMessage.js";

/** A domain this session can both enable and, on cleanup, disable. */
export type CdpRuntimeDomain = CdpDomainWith<"enable"> &
  CdpDomainWith<"disable">;

type Scope = {
  readonly cdp_endpoint: string;
  readonly target_id: string;
  readonly allowed_origins: readonly string[];
  readonly command_timeout_ms?: number | undefined;
};

/** Owned transport and instrumentation; the selected browser/page remain externally owned. */
export class CdpRuntimeSession {
  readonly enabledDomains: CdpRuntimeDomain[] = [];
  preciseCoverageMayBeActive = false;
  #completion: AbortController | undefined;
  #completionTimer: NodeJS.Timeout | undefined;
  constructor(
    readonly transport: CdpTargetSession,
    readonly discovery: CdpEndpointDiscovery,
    readonly target: z.infer<typeof webRuntimeTargetSchema>,
    readonly allowedOrigins: ReadonlySet<string>,
    readonly operation: BrowserObservationOperation,
    readonly options: ExecutionOptions,
    readonly owner: CdpTargetSessionOwner,
    readonly commandTimeoutMs: number,
    /**
     * The target session's page generation from selection onward, checked
     * before any live evidence is joined.
     */
    readonly document: CdpTargetDocument,
  ) {}

  /** Acquire a validated target; failed setup releases its owned socket. */
  static async open(
    input: Scope,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
    owner: CdpTargetSessionOwner,
  ): Promise<CdpRuntimeSession> {
    const commandTimeoutMs = selectedCdpCommandTimeoutMs(
      input.command_timeout_ms,
    );
    // HTTP discovery keeps its own fixed deadline. The WebSocket handshake
    // and a browser-level Target.attachToTarget each get commandTimeoutMs.
    // One deadline around both would expire a valid attach after a slow handshake.
    const discovery = await discoverCdpEndpoint(
      input.cdp_endpoint,
      operation,
      options.signal,
    );
    const { target, allowedOrigins } = authorizeCdpTarget(
      discovery,
      input,
      operation,
    );
    const transport = await openCdpTargetSession(
      discovery,
      target,
      operation,
      options.signal,
      {
        maxPayloadBytes: WEB_RUNTIME_LIMITS.protocolBytes,
        commandTimeoutMs,
      },
      owner,
    );
    try {
      const frame = runtimeMainFrame(
        await runtimeDeadline(
          operation,
          options.signal,
          (signal) =>
            authorizedMainFrame({
              ...transport,
              allowedOrigins,
              signal,
              operation,
            }),
          commandTimeoutMs,
          "command",
          "Page.getFrameTree",
        ),
        allowedOrigins,
        operation,
      );
      const url = runtimeFrameUrl(frame, operation);
      return new CdpRuntimeSession(
        transport,
        discovery,
        {
          target_id: target.id,
          initial_url: url.url,
          origin: url.origin,
          frame_id: frame.document.frameId,
          loader_id: frame.document.loaderId ?? null,
        },
        allowedOrigins,
        operation,
        options,
        owner,
        commandTimeoutMs,
        CdpTargetDocument.watch(transport, frame.document),
      );
    } catch (cause: unknown) {
      try {
        await owner.finish(transport.connection);
      } catch (cleanupCause: unknown) {
        if (
          cause instanceof AnalysisError &&
          cleanupCause instanceof AnalysisError
        )
          throw analysisErrorWithCleanupFailure(cause, cleanupCause, operation);
        throw new AggregateError(
          [cause, cleanupCause],
          `CDP runtime setup ${operation} failed and cleanup remains incomplete.`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /** Bound each command separately from the caller-selected observation duration. */
  async command<M extends CdpCommand>(
    method: M,
    params?: CdpCommandParams<M>,
  ): Promise<CdpCommandResult<M>> {
    const signals = [this.options.signal, this.#completion?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    try {
      return await runtimeDeadline(
        this.operation,
        signals.length === 0 ? undefined : AbortSignal.any(signals),
        (signal) =>
          this.transport.connection.send(
            method,
            params,
            this.transport.sessionId,
            signal,
          ),
        this.commandTimeoutMs,
        "command",
        method,
      );
    } catch (cause: unknown) {
      if (this.#completion?.signal.aborted && !this.options.signal?.aborted) {
        const recovery = cdpCommandDeadlineRecovery(
          this.commandTimeoutMs,
          "source-join",
        );
        throw new AnalysisTimeoutError(
          this.operation,
          this.commandTimeoutMs,
          recovery,
        );
      }
      throw cause;
    }
  }

  /** Bound the complete inspection/source-join phase as well as each individual command. */
  beginCompletion(): void {
    if (this.#completion !== undefined) return;
    this.#completion = new AbortController();
    this.#completionTimer = setTimeout(
      () => this.#completion?.abort(OwnerCancellation.deadlineElapsed),
      this.commandTimeoutMs,
    );
  }

  /** Register cleanup before sending: cancellation can occur after producer acceptance. */
  async enable(domain: CdpRuntimeDomain): Promise<void> {
    this.enabledDomains.push(domain);
    await this.command(`${domain}.enable` as const);
  }

  /**
   * Check document identity before joining any live node or final coverage
   * evidence. A changed document is reported before scope; scope applies to
   * the current document. Runtime evidence cannot carry limited coverage, so
   * an unprovable document that moved or gained a loader stays a change.
   */
  async assertDocument(): Promise<void> {
    // Navigation events observed since selection are reported first, so a
    // change between two reads is not hidden by a reply that looks unchanged.
    this.#assertObservedDocument();
    const frame = runtimeMainFrame(
      await this.command("Page.getFrameTree"),
      this.allowedOrigins,
      this.operation,
    );
    this.document.observe(frame.document);
    this.#assertObservedDocument();
    runtimeFrameUrl(
      frame,
      this.operation,
      `Selected target ${this.target.target_id} moved to an unselected origin during ${this.operation}.`,
    );
    const selected = this.document.selected;
    if (
      this.document.compareSelected(frame.document) === "unknown" &&
      (frame.document.url !== selected.url ||
        frame.document.loaderId !== selected.loaderId)
    )
      throw this.#documentChanged();
  }

  #assertObservedDocument(): void {
    if (this.document.changed) throw this.#documentChanged();
    if (this.document.unidentified)
      throw new BrowserObservationError(this.operation, "protocol_error", {
        detail: `CDP reported a navigation of selected target ${this.target.target_id} without readable frame identity.`,
      });
  }

  #documentChanged(): BrowserObservationError {
    return new BrowserObservationError(this.operation, "target_changed", {
      detail: `Selected target ${this.target.target_id} changed document during ${this.operation}.`,
    });
  }

  /** Cleanup uses its own deadline after caller cancellation, then closes REA's transport. */
  async close(
    previousError: AnalysisError | undefined,
    objectGroup?: string,
  ): Promise<ProviderCleanupError | undefined> {
    if (this.#completionTimer !== undefined)
      clearTimeout(this.#completionTimer);
    this.document.close();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(OwnerCancellation.deadlineElapsed),
      WEB_RUNTIME_LIMITS.cleanupTimeoutMs,
    );
    // Switch before the first restoration send. A short command_timeout_ms
    // would otherwise expire the connection timer and report cleanup_failed.
    this.transport.connection.beginCleanupGrace(
      WEB_RUNTIME_LIMITS.cleanupTimeoutMs,
    );
    const failures: string[] = [];
    let sessionGone = false;
    let transportFailure: AnalysisError | undefined;
    const send = async (
      method: CdpCommand,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<void> => {
      if (sessionGone) return;
      try {
        await this.transport.connection.send(
          method,
          params,
          this.transport.sessionId,
          controller.signal,
        );
      } catch (cause: unknown) {
        if (
          this.transport.sessionId !== undefined &&
          isCdpSessionNotFoundRejection(cause)
        )
          sessionGone = true;
        failures.push(
          `${method}: ${cause instanceof AnalysisError ? (cause.userMessage ?? cause.message) : errorMessage(cause)}`,
        );
      }
    };
    try {
      if (this.preciseCoverageMayBeActive)
        await send("Profiler.stopPreciseCoverage");
      if (objectGroup !== undefined)
        await send("Runtime.releaseObjectGroup", { objectGroup });
      for (const domain of [...this.enabledDomains].reverse())
        await send(`${domain}.disable`);
      if (!sessionGone && this.transport.sessionId !== undefined) {
        try {
          await this.transport.connection.send(
            "Target.detachFromTarget",
            { sessionId: this.transport.sessionId },
            undefined,
            controller.signal,
          );
        } catch (cause: unknown) {
          if (!isCdpSessionNotFoundRejection(cause))
            failures.push(
              `Target.detachFromTarget: ${cause instanceof AnalysisError ? (cause.userMessage ?? cause.message) : errorMessage(cause)}`,
            );
        }
      }
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted) failures.push(cdpCleanupGraceExpired());
      try {
        await this.owner.finish(this.transport.connection);
      } catch (cause: unknown) {
        transportFailure =
          cause instanceof AnalysisError
            ? cause
            : new ProviderCleanupError(
                "rea-cdp-browser",
                [this.target.target_id],
                {
                  reason: errorMessage(cause),
                },
                { operation: this.operation, cause },
              );
        failures.push(
          `CDP WebSocket close: ${transportFailure.userMessage ?? transportFailure.message}`,
        );
      }
    }
    return failures.length === 0
      ? undefined
      : new ProviderCleanupError(
          "rea-cdp-browser",
          [this.target.target_id, "runtime-instrumentation"],
          {
            target_id: this.target.target_id,
            cleanup_failures: failures,
            previous_error:
              previousError?.userMessage ?? previousError?.message ?? null,
          },
          {
            operation: this.operation,
            ...(transportFailure === undefined
              ? {}
              : { cause: transportFailure }),
          },
        );
  }
}

/** Runtime requires document IDs; the frame tree owner parsed them and the URL. */
const runtimeMainFrame = (
  tree: CdpFrameTree,
  allowedOrigins: ReadonlySet<string>,
  operation: BrowserObservationOperation,
) => {
  const document = cdpRootDocument(tree);
  if (document === undefined)
    throw new BrowserObservationError(operation, "protocol_error", {
      detail:
        "CDP Page.getFrameTree did not identify the selected main frame's document.",
    });
  return {
    document,
    ...classifyCdpFrameUrl(tree.root.url, allowedOrigins),
  };
};

const runtimeFrameUrl = (
  frame: ReturnType<typeof runtimeMainFrame>,
  operation: BrowserObservationOperation,
  detail?: string,
) => {
  if (frame.scope === "outside_policy" || frame.scope === "unsupported")
    throw cdpOriginScopeRefusal(
      operation,
      detail === undefined ? {} : { detail },
    );
  if (frame.url === undefined || frame.origin === null)
    throw new BrowserObservationError(operation, "protocol_error");
  return { url: frame.url, origin: frame.origin };
};

/** Apply a disposable command deadline without turning timeout into caller cancellation. */
export const runtimeDeadline = async <T>(
  operation: BrowserObservationOperation,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = selectedCdpCommandTimeoutMs(undefined),
  phase: "handshake" | "command" = "command",
  method?: string,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(OwnerCancellation.deadlineElapsed),
    timeoutMs,
  );
  try {
    return await run(
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]),
    );
  } catch (cause: unknown) {
    if (controller.signal.aborted && signal?.aborted !== true) {
      if (cause instanceof AnalysisError && cause.userMessage !== undefined)
        throw cause;
      const recovery = cdpCommandDeadlineRecovery(
        timeoutMs,
        phase,
        method ?? (phase === "handshake" ? undefined : "session setup"),
      );
      throw new AnalysisTimeoutError(operation, timeoutMs, recovery);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};
