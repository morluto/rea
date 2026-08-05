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
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  boundedText,
  numberValue,
  recordValue,
  stringValue,
  delayWithCancellation,
} from "./CdpCaptureValues.js";
import { CdpConnection, type CdpEvent } from "./CdpConnection.js";
import {
  authorizeRuntimeTargetLocation,
  canonicalRuntimeRoots,
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
      const roots = await canonicalRuntimeRoots(input.allowed_file_roots);
      const discovery = await discoverV8Inspector(
        input.inspector_endpoint,
        "list_javascript_runtime_targets",
        options.signal,
      );
      const allowed: AuthorizedV8InspectorTarget[] = [];
      const excluded = createInspectorExclusionCounts();
      for (const target of discovery.targets) {
        const decision = await authorizeRuntimeTargetLocation(
          target.url,
          target.type,
          roots,
          input.allowed_origins,
        );
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
      const items = allowed
        .slice(input.offset, input.offset + input.limit)
        .map(projectTarget);
      const nextOffset = input.offset + items.length;
      return ok(
        javascriptRuntimeTargetListSchema.parse({
          schema_version: 1,
          runtime: discovery.runtime,
          targets: {
            items,
            offset: input.offset,
            limit: input.limit,
            total: allowed.length,
            next_offset: nextOffset < allowed.length ? nextOffset : null,
            has_more: nextOffset < allowed.length,
          },
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
    try {
      const roots = await canonicalRuntimeRoots(input.allowed_file_roots);
      const discovery = await discoverV8Inspector(
        input.inspector_endpoint,
        "observe_javascript_runtime",
        options.signal,
      );
      const target = await authorizedTarget(discovery.targets, input, roots);
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
        roots,
        state,
      });
      return ok(javascriptRuntimeObservationSchema.parse(result));
    } catch (cause: unknown) {
      return err(providerError(cause, "observe_javascript_runtime"));
    } finally {
      await connection?.close();
    }
  }
}

const projectTarget = (target: AuthorizedV8InspectorTarget) => ({
  target_id: target.id,
  protocol_type: target.type,
  attached: target.attached,
  location: target.location,
});

const authorizedTarget = async (
  targets: readonly V8InspectorTarget[],
  input: ObserveJavaScriptRuntimeInput,
  roots: readonly string[],
): Promise<AuthorizedV8InspectorTarget> => {
  const target = targets.find(({ id }) => id === input.target_id);
  if (target === undefined)
    throw new BrowserObservationError(
      "observe_javascript_runtime",
      "target_not_found",
    );
  const decision = await authorizeRuntimeTargetLocation(
    target.url,
    target.type,
    roots,
    input.allowed_origins,
  );
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
  if (state.eventsObserved > input.limits.max_events) {
    drop(state, "max_events");
    return;
  }
  if (event.method === "Debugger.scriptParsed") {
    ingestScript(event, input, state);
    return;
  }
  if (event.method === "Debugger.scriptFailedToParse") {
    state.invalidScripts += 1;
    retainEvent(state, 0, input);
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
  if (
    rawUrl === undefined ||
    rawUrl === "" ||
    Buffer.byteLength(rawUrl) > input.limits.max_location_bytes
  ) {
    state.invalidScripts += 1;
    retainEvent(state, 0, input);
    return;
  }
  if (state.scripts.length >= input.limits.max_scripts) {
    drop(state, "max_scripts");
    return;
  }
  const draft: ScriptDraft = {
    rawUrl,
    executionContextKey: contextKey(value?.executionContextId),
    cdpHash: boundedText(value?.hash, 512),
    length: nonnegativeInteger(value?.length),
    isModule: value?.isModule === true,
  };
  const bytes = metadataBytes(draft);
  if (!retainEvent(state, bytes, input)) return;
  state.scripts.push(draft);
};

const ingestContext = (
  event: CdpEvent,
  input: ObserveJavaScriptRuntimeInput,
  state: CaptureState,
): void => {
  if (event.method === "Runtime.executionContextsCleared") {
    for (const context of state.contexts.values()) context.state = "cleared";
    retainEvent(state, 0, input);
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
    retainEvent(state, 0, input);
    return;
  }
  if (
    state.contexts.size >= input.limits.max_execution_contexts &&
    !state.contexts.has(key)
  ) {
    drop(state, "max_execution_contexts");
    return;
  }
  const origin =
    event.method === "Runtime.executionContextCreated"
      ? boundedText(runtimeContext?.origin, 4_096)
      : null;
  const draft: ContextDraft = {
    contextKey: key,
    state:
      event.method === "Runtime.executionContextCreated"
        ? "created"
        : "destroyed",
    origin:
      origin !== null && input.allowed_origins.includes(origin) ? origin : null,
  };
  const bytes = metadataBytes(draft);
  if (!retainEvent(state, bytes, input)) return;
  state.contexts.set(key, draft);
};

const retainEvent = (
  state: CaptureState,
  bytes: number,
  input: ObserveJavaScriptRuntimeInput,
): boolean => {
  if (state.metadataBytes + bytes > input.limits.max_total_metadata_bytes) {
    drop(state, "max_total_metadata_bytes");
    return false;
  }
  state.metadataBytes += bytes;
  state.eventsRetained += 1;
  return true;
};

const drop = (state: CaptureState, reason: string): void => {
  state.eventsDropped += 1;
  state.truncated = true;
  state.truncationReasons.add(reason);
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
