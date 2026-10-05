import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  type JavaScriptRuntimeObservation,
  type JavaScriptRuntimeTargetList,
  type ListJavaScriptRuntimeTargetsInput,
  type ObserveJavaScriptRuntimeInput,
} from "../domain/javascriptRuntimeObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  numberValue,
  recordValue,
  stringValue,
  delayWithCancellation,
} from "./CdpCaptureValues.js";
import { CdpConnection, type CdpEvent } from "./CdpConnection.js";
import { authorizeRuntimeTargetLocation } from "./JavaScriptRuntimeScope.js";
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
export const V8_INSPECTOR_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "rea-v8-inspector",
  name: "REA passive Node/Electron V8 Inspector provider",
  version: "1",
});

export interface ScriptDraft {
  readonly rawUrl: string;
  readonly executionContextKey: string | null;
  readonly cdpHash: string | null;
  readonly length: number;
  readonly isModule: boolean;
}

export interface ContextDraft {
  readonly contextKey: string;
  state: "created" | "destroyed" | "cleared";
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
          excluded[decision.reason] += 1;
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
      );
      const state = emptyCaptureState();
      const removeListener = connection.onEvent((event) =>
        ingestEvent(event, input, state),
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

const ingestEvent = (
  event: CdpEvent,
  input: ObserveJavaScriptRuntimeInput,
  state: CaptureState,
): void => {
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
    ingestScript(event, input, state);
    return;
  }
  if (event.method === "Debugger.scriptFailedToParse") {
    state.invalidScripts += 1;
    retainEvent(state, 0);
    return;
  }
  ingestContext(event, input, state);
};

const ingestScript = (
  event: CdpEvent,
  input: ObserveJavaScriptRuntimeInput,
  state: CaptureState,
): void => {
  state.scriptsObserved += 1;
  const value = recordValue(event.params);
  const rawUrl = stringValue(value?.url);
  if (rawUrl === undefined || rawUrl === "") {
    state.invalidScripts += 1;
    retainEvent(state, 0);
    return;
  }
  const draft: ScriptDraft = {
    rawUrl,
    executionContextKey: contextKey(value?.executionContextId),
    cdpHash: stringValue(value?.hash) ?? null,
    length: nonnegativeInteger(value?.length),
    isModule: value?.isModule === true,
  };
  const bytes = metadataBytes(draft);
  retainEvent(state, bytes);
  state.scripts.push(draft);
};

const ingestContext = (
  event: CdpEvent,
  input: ObserveJavaScriptRuntimeInput,
  state: CaptureState,
): void => {
  if (event.method === "Runtime.executionContextsCleared") {
    for (const context of state.contexts.values()) context.state = "cleared";
    retainEvent(state, 0);
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
  const origin =
    event.method === "Runtime.executionContextCreated"
      ? (stringValue(runtimeContext?.origin) ?? null)
      : null;
  const draft: ContextDraft = {
    contextKey: key,
    state:
      event.method === "Runtime.executionContextCreated"
        ? "created"
        : "destroyed",
    origin: origin === "" ? null : origin,
  };
  const bytes = metadataBytes(draft);
  retainEvent(state, bytes);
  state.contexts.set(key, draft);
};

const retainEvent = (state: CaptureState, bytes: number): void => {
  state.metadataBytes += bytes;
  state.eventsRetained += 1;
};

const waitForCapture = async (
  connection: CdpConnection,
  observationMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  let removeDisconnect = (): void => undefined;
  const disconnected = new Promise<never>((_resolve, reject) => {
    removeDisconnect = connection.onDisconnect(() =>
      reject(
        new BrowserObservationError(
          "observe_javascript_runtime",
          "disconnected",
        ),
      ),
    );
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

const metadataBytes = (value: object): number =>
  Buffer.byteLength(JSON.stringify(value));

const nonnegativeInteger = (value: unknown): number => {
  const parsed = numberValue(value);
  return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed));
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
