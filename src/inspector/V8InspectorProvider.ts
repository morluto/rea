import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { JavaScriptRuntimeObservationPort } from "../application/javascript/JavaScriptRuntimeObservationPort.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  type JavaScriptRuntimeObservation,
  type JavaScriptRuntimeTargetList,
  type ListJavaScriptRuntimeTargetsInput,
  type ObserveJavaScriptRuntimeInput,
} from "../domain/javascript/javascriptRuntimeObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  numberValue,
  recordValue,
  cdpStringValue,
  scriptMetadataValues,
  delayWithCancellation,
} from "../browser/CdpCaptureValues.js";
import { CdpConnection, type CdpEvent } from "../browser/CdpConnection.js";
import {
  authorizeRuntimeTargetLocation,
  inspectorExclusionKey,
} from "./JavaScriptRuntimeScope.js";
import {
  createInspectorExclusionCounts,
  describeInspectorTargetLimitations,
  finalizeInspectorCapture,
} from "./V8InspectorCaptureProjection.js";
import {
  discoverV8Inspector,
  type AuthorizedV8InspectorTarget,
  type V8InspectorTarget,
} from "./V8InspectorEndpoint.js";

/** Public identity committed by passive V8 Inspector observations. */
export { V8_INSPECTOR_PROVIDER_IDENTITY } from "./providerIdentity.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "./providerIdentity.js";

/** Maximum decoded CDP message accepted while observing one Inspector target. */
export const INSPECTOR_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Aggregate retained metadata budget, including an estimate of JS object overhead. */
export const INSPECTOR_MAX_RETAINED_METADATA_BYTES = 8 * 1024 * 1024;
const RETAINED_OBJECT_OVERHEAD_BYTES = 512;

export interface ScriptDraft {
  readonly rawUrl: string;
  readonly executionContextKey: string | null;
  readonly cdpHash: string | null;
  readonly length: number | null;
  readonly isModule: boolean | null;
}

export interface ContextDraft {
  readonly contextKey: string;
  state: "created" | "destroyed" | "cleared";
  readonly name: string | null;
  readonly origin: string | null;
}

export interface CaptureState {
  readonly scripts: ScriptDraft[];
  readonly contexts: Map<string, ContextDraft>;
  eventsObserved: number;
  eventsRetained: number;
  eventsDropped: number;
  metadataBytes: number;
  scriptsObserved: number;
  invalidScripts: number;
  truncated: boolean;
  readonly truncationReasons: Set<string>;
}

/** Attach-only provider; sends only Runtime.enable and Debugger.enable. */
export class V8InspectorProvider implements JavaScriptRuntimeObservationPort {
  identity(): ProviderIdentity {
    return V8_INSPECTOR_PROVIDER_IDENTITY;
  }

  async listTargets(
    input: ListJavaScriptRuntimeTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<JavaScriptRuntimeTargetList, AnalysisError>> {
    try {
      const discovery = await discoverV8Inspector(
        input.inspector_endpoint,
        "list_javascript_runtime_targets",
        options.signal,
      );
      const allowed: AuthorizedV8InspectorTarget[] = [];
      const excluded = createInspectorExclusionCounts();
      for (const target of discovery.targets) {
        const decision = await authorizeRuntimeTargetLocation(target.url, {
          type: target.type,
          product: discovery.runtime.product,
        });
        if (!decision.allowed) {
          excluded[inspectorExclusionKey(decision.reason)] += 1;
          continue;
        }
        if (decision.location.kind === "builtin") {
          excluded.unsupported_location += 1;
          continue;
        }
        allowed.push({ ...target, location: decision.location });
      }
      allowed.sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
      return ok(
        javascriptRuntimeTargetListSchema.parse({
          runtime: discovery.runtime,
          targets: allowed.map(projectTarget),
          excluded: { ...excluded, unconnectable: 0 },
          limitations: describeInspectorTargetLimitations(),
        }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "list_javascript_runtime_targets"));
    }
  }

  async observe(
    input: ObserveJavaScriptRuntimeInput,
    options: ExecutionOptions = {},
  ): Promise<Result<JavaScriptRuntimeObservation, AnalysisError>> {
    let connection: CdpConnection | undefined;
    let primaryFailure: unknown;
    let failed = false;
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    let outcome:
      | Result<JavaScriptRuntimeObservation, AnalysisError>
      | undefined;
    try {
      const discovery = await discoverV8Inspector(
        input.inspector_endpoint,
        "observe_javascript_runtime",
        options.signal,
      );
      const target = await authorizedTarget(
        discovery.targets,
        input,
        discovery.runtime.product,
      );
      if (input.runtime_kind !== undefined)
        assertRuntimeKind(target, input.runtime_kind);
      connection = await CdpConnection.connect(
        target.webSocketUrl,
        "observe_javascript_runtime",
        options.signal,
        { maxPayloadBytes: INSPECTOR_MAX_PAYLOAD_BYTES },
      );
      const state = emptyCaptureState();
      const removeListener = connection.onEvent((event) =>
        ingestEvent(event, state),
      );
      try {
        await connection.send("Runtime.enable", {}, undefined, options.signal);
        await connection.send("Debugger.enable", {}, undefined, options.signal);
        await waitForCapture(connection, input.observation_ms, options.signal);
      } finally {
        removeListener();
      }
      const result = await finalizeInspectorCapture({
        input,
        runtime: discovery.runtime,
        target,
        state,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      outcome = ok(javascriptRuntimeObservationSchema.parse(result));
    } catch (cause: unknown) {
      failed = true;
      primaryFailure = cause;
      outcome = err(providerError(cause, "observe_javascript_runtime"));
    } finally {
      if (connection !== undefined)
        try {
          await closeInspectorConnection(connection, options.signal);
        } catch (cause: unknown) {
          cleanupFailed = true;
          cleanupFailure = cause;
        }
    }
    if (cleanupFailed) {
      return err(inspectorCleanupError(primaryFailure, cleanupFailure, failed));
    }
    return (
      outcome ??
      err(
        new BrowserObservationError(
          "observe_javascript_runtime",
          "protocol_error",
        ),
      )
    );
  }
}

export const closeInspectorConnection = async (
  connection: Pick<CdpConnection, "close">,
  signal?: AbortSignal,
): Promise<void> => {
  const closing = connection.close();
  // best-effort cleanup: the race below observes the close; this only prevents
  // unhandled rejection when the caller abandons the close via cancellation.
  void closing.catch(() => undefined);
  // CdpConnection.close has its own one second transport bound. Do not make a
  // cancelled caller wait for that fallback.
  if (signal === undefined) return await closing;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([closing, cancelled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

export const inspectorCleanupError = (
  primaryFailure: unknown,
  cleanupFailure: unknown,
  hasPrimaryFailure: boolean,
): BrowserObservationError => {
  const cause = hasPrimaryFailure
    ? new AggregateError(
        [primaryFailure, cleanupFailure],
        "Inspector observation and cleanup both failed",
      )
    : cleanupFailure;
  return new BrowserObservationError(
    "observe_javascript_runtime",
    "cleanup_failed",
    { cause },
  );
};

const projectTarget = (target: AuthorizedV8InspectorTarget) => ({
  target_id: target.id,
  protocol_type: target.type,
  attached: target.attached,
  location: target.location,
});

const authorizedTarget = async (
  targets: readonly V8InspectorTarget[],
  input: ObserveJavaScriptRuntimeInput,
  product: string,
): Promise<AuthorizedV8InspectorTarget> => {
  const target = targets.find(({ id }) => id === input.target_id);
  if (target === undefined)
    throw new BrowserObservationError(
      "observe_javascript_runtime",
      "target_not_found",
    );
  const decision = await authorizeRuntimeTargetLocation(target.url, {
    type: target.type,
    product,
  });
  if (
    target.attached ||
    !decision.allowed ||
    decision.location.kind === "builtin"
  )
    throw new BrowserObservationError(
      "observe_javascript_runtime",
      "target_not_allowed",
    );
  return { ...target, location: decision.location };
};

const assertRuntimeKind = (
  target: AuthorizedV8InspectorTarget,
  kind: ObserveJavaScriptRuntimeInput["runtime_kind"],
): void => {
  const accepted =
    kind === "electron-preload" || kind === "electron-renderer"
      ? target.type === "page"
      : target.type === "node";
  if (!accepted)
    throw new BrowserObservationError(
      "observe_javascript_runtime",
      "target_not_allowed",
    );
};

const emptyCaptureState = (): CaptureState => ({
  scripts: [],
  contexts: new Map(),
  eventsObserved: 0,
  eventsRetained: 0,
  eventsDropped: 0,
  metadataBytes: 0,
  scriptsObserved: 0,
  invalidScripts: 0,
  truncated: false,
  truncationReasons: new Set(),
});

const ingestEvent = (event: CdpEvent, state: CaptureState): void => {
  if (
    event.method !== "Debugger.scriptParsed" &&
    event.method !== "Debugger.scriptFailedToParse" &&
    event.method !== "Runtime.executionContextCreated" &&
    event.method !== "Runtime.executionContextDestroyed" &&
    event.method !== "Runtime.executionContextsCleared"
  )
    return;
  state.eventsObserved += 1;
  if (event.method === "Debugger.scriptParsed") {
    ingestScript(event, state);
    return;
  }
  if (event.method === "Debugger.scriptFailedToParse") {
    state.invalidScripts += 1;
    retainEvent(state, 0);
    return;
  }
  ingestContext(event, state);
};

const ingestScript = (event: CdpEvent, state: CaptureState): void => {
  state.scriptsObserved += 1;
  const value = recordValue(event.params);
  const rawUrl = cdpStringValue(value?.url);
  if (rawUrl === undefined || rawUrl === "") {
    state.invalidScripts += 1;
    retainEvent(state, 0);
    return;
  }
  const metadata = scriptMetadataValues(value);
  const draft: ScriptDraft = {
    rawUrl,
    executionContextKey: contextKey(value?.executionContextId),
    cdpHash: metadata.hash,
    length: metadata.length,
    isModule: metadata.isModule,
  };
  const bytes = retainedMetadataBytes(draft);
  if (!retainEvent(state, bytes)) return;
  state.scripts.push(draft);
};

const ingestContext = (event: CdpEvent, state: CaptureState): void => {
  if (event.method === "Runtime.executionContextsCleared") {
    let byteDelta = 0;
    for (const context of state.contexts.values()) {
      byteDelta +=
        retainedMetadataBytes({ ...context, state: "cleared" }) -
        retainedMetadataBytes(context);
    }
    if (replaceRetainedMetadata(state, byteDelta)) {
      for (const context of state.contexts.values()) context.state = "cleared";
      retainEvent(state, 0);
    }
    return;
  }
  const parameters = recordValue(event.params);
  const runtimeContext =
    event.method === "Runtime.executionContextCreated"
      ? recordValue(parameters?.context)
      : parameters;
  const key = contextKey(
    event.method === "Runtime.executionContextCreated"
      ? runtimeContext?.id
      : runtimeContext?.executionContextId,
  );
  if (key === null) {
    retainEvent(state, 0);
    return;
  }
  const previous = state.contexts.get(key);
  const created = event.method === "Runtime.executionContextCreated";
  const draft: ContextDraft = {
    contextKey: key,
    state: created ? "created" : "destroyed",
    name: created
      ? (cdpStringValue(runtimeContext?.name) ?? null)
      : (previous?.name ?? null),
    origin: created
      ? (cdpStringValue(runtimeContext?.origin) ?? null)
      : (previous?.origin ?? null),
  };
  const bytes =
    retainedMetadataBytes(draft) -
    (previous === undefined ? 0 : retainedMetadataBytes(previous));
  if (!retainEvent(state, bytes)) return;
  state.contexts.set(key, draft);
};

const retainEvent = (state: CaptureState, bytes: number): boolean => {
  if (!replaceRetainedMetadata(state, bytes)) return false;
  state.eventsRetained += 1;
  return true;
};

const replaceRetainedMetadata = (
  state: CaptureState,
  byteDelta: number,
): boolean => {
  if (state.metadataBytes + byteDelta > INSPECTOR_MAX_RETAINED_METADATA_BYTES) {
    state.eventsDropped += 1;
    state.truncated = true;
    state.truncationReasons.add("retained_metadata_budget_exceeded");
    return false;
  }
  state.metadataBytes += byteDelta;
  return true;
};

const waitForCapture = async (
  connection: CdpConnection,
  observationMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  let removeDisconnect = (): void => undefined;
  const disconnected = new Promise<never>((_resolve, reject) => {
    removeDisconnect = connection.onDisconnect((error) => reject(error));
  });
  try {
    await Promise.race([
      delayWithCancellation(
        observationMs,
        "observe_javascript_runtime",
        signal,
      ),
      disconnected,
    ]);
  } finally {
    removeDisconnect();
  }
};

const retainedMetadataBytes = (value: ScriptDraft | ContextDraft): number => {
  const strings =
    "rawUrl" in value
      ? [value.rawUrl, value.rawUrl, value.executionContextKey, value.cdpHash]
      : [value.contextKey, value.name, value.origin];
  return (
    RETAINED_OBJECT_OVERHEAD_BYTES +
    strings.reduce((total, text) => total + (text?.length ?? 0) * 2, 0)
  );
};

const contextKey = (value: unknown): string | null => {
  const identifier = numberValue(value);
  return identifier !== undefined && Number.isSafeInteger(identifier)
    ? String(identifier)
    : null;
};

const providerError = (
  cause: unknown,
  operation: BrowserObservationOperation,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  return new ProviderAdapterError(
    V8_INSPECTOR_PROVIDER_IDENTITY.id,
    operation,
    {
      cause,
    },
  );
};
