import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisTimeoutError } from "../../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { sanitizeBrowserUrl } from "../../domain/browserObservation.js";
import {
  WEB_RUNTIME_LIMITS,
  type webRuntimeTargetSchema,
} from "../../domain/webRuntime.js";
import type { z } from "zod";
import { authorizeCdpTarget } from "../CdpAuthorizedTarget.js";
import { authorizedMainFrame } from "../CdpAuthorizedMainFrame.js";
import {
  discoverCdpEndpoint,
  type CdpEndpointDiscovery,
} from "../CdpEndpoint.js";
import {
  openCdpTargetSession,
  type CdpTargetSession,
} from "../CdpTargetSession.js";
import { runtimeFrameTreeSchema } from "./CdpRuntimeProtocol.js";

type Scope = {
  readonly cdp_endpoint: string;
  readonly target_id: string;
  readonly allowed_origins: readonly string[];
};

/** Owned transport and instrumentation; the selected browser/page remain externally owned. */
export class CdpRuntimeSession {
  readonly enabledDomains: string[] = [];
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
  ) {}

  /** Acquire a validated target; failed setup releases its owned socket. */
  static async open(
    input: Scope,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
  ): Promise<CdpRuntimeSession> {
    return runtimeDeadline(operation, options.signal, async (signal) => {
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        operation,
        signal,
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
        signal,
        { maxPayloadBytes: WEB_RUNTIME_LIMITS.protocolBytes },
      );
      try {
        const tree = runtimeFrameTreeSchema.parse(
          await authorizedMainFrame({
            ...transport,
            allowedOrigins,
            signal,
            operation,
          }),
        );
        const frame = tree.frameTree.frame;
        const url = sanitizeBrowserUrl(frame.url);
        if (url.origin === null)
          throw new BrowserObservationError(operation, "target_not_allowed");
        return new CdpRuntimeSession(
          transport,
          discovery,
          {
            target_id: target.id,
            initial_url: url.url,
            origin: url.origin,
            frame_id: frame.id,
            loader_id: frame.loaderId ?? null,
          },
          allowedOrigins,
          operation,
          options,
        );
      } catch (cause: unknown) {
        await transport.connection.close();
        throw cause;
      }
    });
  }

  /** Bound each command separately from the caller-selected observation duration. */
  async command(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
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
      );
    } catch (cause: unknown) {
      if (this.#completion?.signal.aborted && !this.options.signal?.aborted)
        throw new AnalysisTimeoutError(
          this.operation,
          WEB_RUNTIME_LIMITS.commandTimeoutMs,
        );
      throw cause;
    }
  }

  /** Bound the complete inspection/source-join phase as well as each individual command. */
  beginCompletion(): void {
    if (this.#completion !== undefined) return;
    this.#completion = new AbortController();
    this.#completionTimer = setTimeout(
      () => this.#completion?.abort(),
      WEB_RUNTIME_LIMITS.commandTimeoutMs,
    );
  }

  /** Register cleanup before sending: cancellation can occur after producer acceptance. */
  async enable(domain: string): Promise<void> {
    this.enabledDomains.push(domain);
    await this.command(`${domain}.enable`);
  }

  /** Check document identity before joining any live node or final coverage evidence. */
  async assertDocument(): Promise<void> {
    const frame = runtimeFrameTreeSchema.parse(
      await this.command("Page.getFrameTree"),
    ).frameTree.frame;
    const url = sanitizeBrowserUrl(frame.url);
    if (
      frame.id !== this.target.frame_id ||
      (frame.loaderId ?? null) !== this.target.loader_id ||
      (this.target.loader_id === null && url.url !== this.target.initial_url)
    )
      throw new BrowserObservationError(this.operation, "target_changed", {
        detail: `Selected target ${this.target.target_id} changed document during ${this.operation}.`,
      });
    if (url.origin === null || !this.allowedOrigins.has(url.origin))
      throw new BrowserObservationError(this.operation, "target_not_allowed", {
        detail: `Selected target ${this.target.target_id} moved to an unselected origin during ${this.operation}.`,
      });
  }

  /** Cleanup uses its own deadline after caller cancellation, then closes REA's transport. */
  async close(
    previousError: AnalysisError | undefined,
    objectGroup?: string,
  ): Promise<ProviderCleanupError | undefined> {
    if (this.#completionTimer !== undefined)
      clearTimeout(this.#completionTimer);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      WEB_RUNTIME_LIMITS.cleanupTimeoutMs,
    );
    const failures: string[] = [];
    const send = async (
      method: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<void> => {
      try {
        await this.transport.connection.send(
          method,
          params,
          this.transport.sessionId,
          controller.signal,
        );
      } catch (cause: unknown) {
        failures.push(
          `${method}: ${cause instanceof AnalysisError ? (cause.userMessage ?? cause.message) : cause instanceof Error ? cause.message : String(cause)}`,
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
      if (this.transport.sessionId !== undefined) {
        try {
          await this.transport.connection.send(
            "Target.detachFromTarget",
            { sessionId: this.transport.sessionId },
            undefined,
            controller.signal,
          );
        } catch (cause: unknown) {
          failures.push(
            `Target.detachFromTarget: ${cause instanceof AnalysisError ? (cause.userMessage ?? cause.message) : cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    } finally {
      clearTimeout(timer);
      await this.transport.connection.close();
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
          { operation: this.operation },
        );
  }
}

/** Apply a disposable command deadline without turning timeout into caller cancellation. */
export const runtimeDeadline = async <T>(
  operation: BrowserObservationOperation,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    WEB_RUNTIME_LIMITS.commandTimeoutMs,
  );
  try {
    return await run(
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]),
    );
  } catch (cause: unknown) {
    if (controller.signal.aborted && signal?.aborted !== true)
      throw new AnalysisTimeoutError(
        operation,
        WEB_RUNTIME_LIMITS.commandTimeoutMs,
      );
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};
