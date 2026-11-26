import { z } from "zod";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { WebRuntimePort } from "../../ports/WebRuntimePort.js";
import {
  AnalysisError,
  type AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { finalizedResult, runOwned } from "../../providers/runOwned.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  webExecutionObservationSchema,
  type ObserveWebExecutionInput,
  type WebExecution,
} from "../../domain/webExecution.js";
import {
  webEventListenersObservationSchema,
  type InspectWebEventListenersInput,
  type WebEventListeners,
} from "../../domain/webEventListeners.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "../providerIdentities.js";
import { CdpTargetSessionOwner } from "../CdpTargetSessionOwner.js";
import { CdpRuntimeSession } from "./CdpRuntimeSession.js";
import { CdpRuntimeSources } from "./CdpRuntimeSources.js";
import { captureWebExecution } from "./CdpExecutionCapture.js";
import {
  captureWebEventListeners,
  eventListenerObjectGroup,
} from "./CdpEventListeners.js";

/** Native CDP integration with distinct inspection/instrumentation authority and confirmed cleanup. */
export class CdpWebRuntimeProvider implements WebRuntimePort {
  readonly #owner = new CdpTargetSessionOwner();

  close(): Promise<void> {
    return this.#owner.close();
  }

  /** Identify this adapter independently of the captured browser version. */
  identity() {
    return CDP_BROWSER_PROVIDER_IDENTITY;
  }

  /** Observe one instrumented window while preserving the externally owned page. */
  observeExecution(
    input: ObserveWebExecutionInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebExecution, AnalysisError>> {
    return this.run(
      input,
      "observe_web_execution",
      options,
      webExecutionObservationSchema,
      (sources) => captureWebExecution(input, sources),
      (observation) => ({
        ...observation,
        instrumentation: {
          ...observation.instrumentation,
          cleanup: "confirmed" as const,
        },
      }),
    );
  }
  /** Inspect one selected node's registered callback locations. */
  inspectEventListeners(
    input: InspectWebEventListenersInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebEventListeners, AnalysisError>> {
    const group = eventListenerObjectGroup();
    return this.run(
      input,
      "inspect_web_event_listeners",
      options,
      webEventListenersObservationSchema,
      (sources) => captureWebEventListeners(input, sources, group),
      (observation) => ({ ...observation, cleanup: "confirmed" as const }),
      group,
    );
  }

  private async run<T extends AnalysisPartialObservation, Completed extends T>(
    input: ObserveWebExecutionInput | InspectWebEventListenersInput,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
    schema: z.ZodType<T>,
    capture: (sources: CdpRuntimeSources) => Promise<T>,
    confirmCleanup: (observation: T) => Completed,
    group?: string,
  ): Promise<Result<Completed, AnalysisError>> {
    let session: CdpRuntimeSession | undefined;
    let primary: AnalysisError | undefined;
    let cleanupConfirmed = false;
    const outcome = await runOwned<T>(
      async () => {
        try {
          session = await CdpRuntimeSession.open(
            input,
            operation,
            options,
            this.#owner,
          );
          return ok(
            schema.parse(await capture(new CdpRuntimeSources(session))),
          );
        } catch (cause: unknown) {
          return err(
            cause instanceof AnalysisError
              ? cause
              : cause instanceof z.ZodError
                ? new AnalysisOutputError(operation, cause.message)
                : new ProviderAdapterError(this.identity().id, operation, {
                    cause,
                  }),
          );
        }
      },
      {
        providerId: this.identity().id,
        operation,
        signal: options.signal,
        inspectPrimary: (result) => {
          if (!result.ok) primary = result.error;
        },
        close: async () => {
          const failure = await session?.close(primary, group);
          if (failure !== undefined) throw failure;
          cleanupConfirmed = true;
        },
        partial: (observation) =>
          cleanupConfirmed ? confirmCleanup(observation) : observation,
      },
    );
    const result = finalizedResult(outcome);
    return result.ok ? ok(confirmCleanup(result.value)) : result;
  }
}
