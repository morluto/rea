import { createHash } from "node:crypto";

import type {
  JavaScriptRuntimeLocation,
  JavaScriptRuntimeObservation,
  JavaScriptRuntimeTargetList,
  ObserveJavaScriptRuntimeInput,
} from "../domain/javascript/javascriptRuntimeObservation.js";
import {
  authorizeRuntimeLocation,
  inspectorExclusionKey,
  throwIfRuntimeObservationCancelled,
} from "./JavaScriptRuntimeScope.js";
import type { CaptureState, ScriptDraft } from "./V8InspectorProvider.js";
import type { AuthorizedV8InspectorTarget } from "./V8InspectorEndpoint.js";

type ExclusionReason = "unsupported_location";

/** Empty durable-location exclusion counters. */
export const createInspectorExclusionCounts = (): Record<
  ExclusionReason,
  number
> => ({
  unsupported_location: 0,
});

/** Stable safety and protocol limitations shared by target-list Evidence. */
export const describeInspectorTargetLimitations = (): string[] => [
  "REA attaches to an already-running exact target and never launches, resumes, evaluates, pauses, or mutates it.",
  "Only Runtime.enable and Debugger.enable are sent; source text, object values, EventEmitter activity, and Electron IPC are not inspected.",
  "The selected endpoint and target ID authorize observation; discovery file locations can remain unresolved and do not prove filesystem identity.",
  "Node discovery reports a best-effort pathname rather than an encoded file URL; lossy Windows paths and ambiguous underscores are preserved without guessing a file path.",
  "Every target exposed by the selected Inspector endpoint is eligible for observation; target IDs and locations are not authenticated as operating-system process identity.",
  "No runtime graph depth is traversed because passive Inspector events do not establish require/import caller edges.",
];

interface FinalizeCaptureInput {
  readonly input: ObserveJavaScriptRuntimeInput;
  readonly runtime: JavaScriptRuntimeTargetList["runtime"];
  readonly target: AuthorizedV8InspectorTarget;
  readonly state: CaptureState;
  readonly authorizeLocation?: (
    rawUrl: string,
    signal?: AbortSignal,
  ) => ReturnType<typeof authorizeRuntimeLocation>;
  readonly signal?: AbortSignal;
}

const LOCATION_AUTHORIZATION_WORKERS = 8;

interface AuthorizedLocationGroup {
  readonly drafts: readonly ScriptDraft[];
  readonly decision: Awaited<ReturnType<typeof authorizeRuntimeLocation>>;
}

/** Canonically authorize, deduplicate, and sort one bounded raw capture. */
export const finalizeInspectorCapture = async ({
  input,
  runtime,
  target,
  state,
  authorizeLocation = authorizeRuntimeLocation,
  signal,
}: FinalizeCaptureInput): Promise<JavaScriptRuntimeObservation> => {
  throwIfRuntimeObservationCancelled(signal);
  const exclusions = createInspectorExclusionCounts();
  const scripts = new Map<
    string,
    JavaScriptRuntimeObservation["scripts"]["items"][number]
  >();
  const draftsByUrl = new Map<string, ScriptDraft[]>();
  for (const draft of state.scripts) {
    const drafts = draftsByUrl.get(draft.rawUrl) ?? [];
    drafts.push(draft);
    draftsByUrl.set(draft.rawUrl, drafts);
  }
  const groups = [...draftsByUrl];
  const authorizedGroups: AuthorizedLocationGroup[] = new Array(groups.length);
  let nextGroup = 0;
  let stopScheduling = false;
  const worker = async (): Promise<void> => {
    try {
      for (;;) {
        throwIfRuntimeObservationCancelled(signal);
        if (stopScheduling) return;
        const index = nextGroup;
        nextGroup += 1;
        const group = groups[index];
        if (group === undefined) return;
        const [rawUrl, drafts] = group;
        authorizedGroups[index] = {
          drafts,
          decision: await authorizeLocation(rawUrl, signal),
        };
        throwIfRuntimeObservationCancelled(signal);
      }
    } catch (cause: unknown) {
      stopScheduling = true;
      throw cause;
    }
  };
  const workerResults = await Promise.allSettled(
    Array.from(
      { length: Math.min(LOCATION_AUTHORIZATION_WORKERS, groups.length) },
      worker,
    ),
  );
  const failedWorker = workerResults.find(
    (result) => result.status === "rejected",
  );
  throwIfRuntimeObservationCancelled(signal);
  if (failedWorker?.status === "rejected") throw failedWorker.reason;
  for (const { drafts, decision } of authorizedGroups) {
    for (const draft of drafts) {
      if (!decision.allowed) {
        exclusions[inspectorExclusionKey(decision.reason)] += 1;
        continue;
      }
      const script = scriptFromDraft(draft, decision.location);
      scripts.set(script.script_key, script);
    }
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
      name: context.name,
      origin: context.origin,
    }))
    .sort((left, right) =>
      left.context_key < right.context_key
        ? -1
        : left.context_key > right.context_key
          ? 1
          : 0,
    );
  throwIfRuntimeObservationCancelled(signal);
  return {
    runtime,
    target: {
      target_id: target.id,
      protocol_type: target.type,
      attached: target.attached,
      location: target.location,
      runtime_kind: input.runtime_kind ?? "unknown",
      runtime_kind_authority:
        input.runtime_kind === undefined
          ? "not-declared"
          : "caller-declared-unverified",
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
      ...(target.location.kind === "unresolved"
        ? [
            "The discovery-reported file location cannot be verified; loaded script locations are resolved independently from Debugger.scriptParsed.",
          ]
        : []),
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
