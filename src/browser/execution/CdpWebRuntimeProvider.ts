import { z } from "zod";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { WebRuntimePort } from "../../application/WebRuntimePort.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  webExecutionSchema,
  type ObserveWebExecutionInput,
  type WebExecution,
} from "../../domain/webExecution.js";
import {
  webEventListenersSchema,
  type InspectWebEventListenersInput,
  type WebEventListeners,
} from "../../domain/webEventListeners.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "../providerIdentities.js";
import { CdpRuntimeSession } from "./CdpRuntimeSession.js";
import { CdpRuntimeSources } from "./CdpRuntimeSources.js";
import { captureWebExecution } from "./CdpExecutionCapture.js";
import {
  captureWebEventListeners,
  eventListenerObjectGroup,
} from "./CdpEventListeners.js";

/** Native CDP integration with distinct inspection/instrumentation authority and confirmed cleanup. */
export class CdpWebRuntimeProvider implements WebRuntimePort {
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
      webExecutionSchema,
      (sources) => captureWebExecution(input, sources),
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
      webEventListenersSchema,
      (sources) => captureWebEventListeners(input, sources, group),
      group,
    );
  }

  private async run<T>(
    input: ObserveWebExecutionInput | InspectWebEventListenersInput,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
    schema: z.ZodType<T>,
    capture: (sources: CdpRuntimeSources) => Promise<T>,
    group?: string,
  ): Promise<Result<T, AnalysisError>> {
    let session: CdpRuntimeSession | undefined;
    let result: Result<T, AnalysisError>;
    try {
      session = await CdpRuntimeSession.open(input, operation, options);
      result = ok(schema.parse(await capture(new CdpRuntimeSources(session))));
    } catch (cause: unknown) {
      result = err(
        cause instanceof AnalysisError
          ? cause
          : cause instanceof z.ZodError
            ? new AnalysisOutputError(operation, cause.message)
            : new ProviderAdapterError(this.identity().id, operation, {
                cause,
              }),
      );
    }
    if (session !== undefined) {
      const failure = await session.close(
        result.ok ? undefined : result.error,
        group,
      );
      if (failure !== undefined) return err(failure);
    }
    return result;
  }
}
