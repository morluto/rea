import { createHash } from "node:crypto";

import type {
  JavaScriptRuntimeLocation,
  JavaScriptRuntimeObservation,
  JavaScriptRuntimeTargetList,
  ObserveJavaScriptRuntimeInput,
} from "../domain/javascriptRuntimeObservation.js";
import { authorizeRuntimeLocation } from "./JavaScriptRuntimeScope.js";
import type { CaptureState, ScriptDraft } from "./V8InspectorProvider.js";
import type { AuthorizedV8InspectorTarget } from "./V8InspectorEndpoint.js";

type ExclusionReason =
  | "outside_file_roots"
  | "outside_origins"
  | "unsupported_location";

/** Empty durable-location exclusion counters. */
export const createInspectorExclusionCounts = (): Record<
  ExclusionReason,
  number
> => ({
  outside_file_roots: 0,
  outside_origins: 0,
  unsupported_location: 0,
});

/** Stable safety and protocol limitations shared by target-list Evidence. */
export const describeInspectorTargetLimitations = (): string[] => [
  "REA attaches to an already-running exact target and never launches, resumes, evaluates, pauses, or mutates it.",
  "Only Runtime.enable and Debugger.enable are sent; source text, object values, EventEmitter activity, and Electron IPC are not inspected.",
  "Target IDs and locations are authorized, but the Inspector protocol does not authenticate an operating-system process ID or Electron role.",
  "Some Electron main targets report only file://; for those targets, the first approved file root is recorded as a scope fallback and script locations are authorized independently.",
  "No runtime graph depth is traversed because passive Inspector events do not establish require/import caller edges.",
];

interface FinalizeCaptureInput {
  readonly input: ObserveJavaScriptRuntimeInput;
  readonly runtime: JavaScriptRuntimeTargetList["runtime"];
  readonly target: AuthorizedV8InspectorTarget;
  readonly roots: readonly string[];
  readonly state: CaptureState;
}

/** Canonically authorize, deduplicate, and sort one bounded raw capture. */
export const finalizeInspectorCapture = async ({
  input,
  runtime,
  target,
  roots,
  state,
}: FinalizeCaptureInput): Promise<JavaScriptRuntimeObservation> => {
  const exclusions = createInspectorExclusionCounts();
  const scripts = new Map<
    string,
    JavaScriptRuntimeObservation["scripts"]["items"][number]
  >();
  for (const draft of state.scripts) {
    const decision = await authorizeRuntimeLocation(
      draft.rawUrl,
      roots,
      input.allowed_origins,
    );
    if (!decision.allowed) {
      exclusions[decision.reason] += 1;
      continue;
    }
    const script = scriptFromDraft(draft, decision.location);
    scripts.set(script.script_key, script);
  }
  const items = [...scripts.values()].sort((left, right) =>
    left.script_key < right.script_key
      ? -1
      : left.script_key > right.script_key
        ? 1
        : 0,
  );
  const contexts = [...state.contexts.values()]
    .map((context) => ({
      context_key: context.contextKey,
      state: context.state,
      name: null,
      origin: context.origin,
    }))
    .sort((left, right) =>
      left.context_key < right.context_key
        ? -1
        : left.context_key > right.context_key
          ? 1
          : 0,
    );
  return {
    schema_version: 1,
    runtime,
    target: {
      target_id: target.id,
      protocol_type: target.type,
      attached: target.attached,
      location: target.location,
      runtime_kind: input.runtime_kind,
      runtime_kind_authority: "caller-declared-unverified",
    },
    capture: {
      observation_ms: input.observation_ms,
      events_observed: state.eventsObserved,
      events_retained: state.eventsRetained,
      events_dropped: state.eventsDropped,
      metadata_bytes_retained: state.metadataBytes,
      truncated: state.truncated,
      truncation_reasons: [...state.truncationReasons].sort(),
    },
    scripts: {
      items,
      observed_total: state.scriptsObserved,
      excluded: {
        ...exclusions,
        invalid_protocol_value: state.invalidScripts,
      },
    },
    execution_contexts: contexts,
    directly_observed: [
      "Debugger.scriptParsed established script presence within the bounded capture window.",
      "Runtime execution-context lifecycle events established context creation, destruction, or clearing.",
    ],
    unavailable_without_instrumentation: [
      "require/import caller-to-callee edges",
      "EventEmitter emissions and listener invocation",
      "Electron IPC messages and handlers",
      "script unload events",
    ],
    unknowns: [
      "Scripts collected before attachment may have been garbage-collected and therefore omitted.",
      "A bounded observation window cannot establish that an unobserved script or behavior never occurs.",
      "The declared Node/Electron process role is not authenticated by the Inspector protocol.",
    ],
    limitations: describeInspectorTargetLimitations(),
  };
};

const scriptFromDraft = (
  draft: ScriptDraft,
  location: JavaScriptRuntimeLocation,
): JavaScriptRuntimeObservation["scripts"]["items"][number] => {
  const stable = JSON.stringify({
    location,
    execution_context_key: draft.executionContextKey,
    cdp_hash: draft.cdpHash,
    length: draft.length,
    is_module: draft.isModule,
  });
  return {
    script_key: `v8_script_${createHash("sha256").update(stable).digest("hex")}`,
    location,
    execution_context_key: draft.executionContextKey,
    cdp_hash: draft.cdpHash,
    length: draft.length,
    is_module: draft.isModule,
    status: "observed-loaded",
  };
};
