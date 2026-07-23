import type {
  FilesystemCheckpoint,
  InteractionEvent,
} from "../domain/processCapture.js";
import { createProcessObservation } from "../domain/processObservation.js";
import type { ProcessReactiveEffectResult } from "../domain/processReactiveRuntime.js";
import type {
  ProcessReactiveAction,
  ProcessReactiveScenario,
} from "../domain/processReactiveScenario.js";
import type { ProcessCaptureJournal } from "./ProcessCaptureJournal.js";

/** Minimal PTY authority used by the admitted reactive action slice. */
export interface ProcessReactiveTerminal {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

/** Rendered-terminal resize seam kept in lockstep with the PTY. */
export interface ProcessReactiveRenderer {
  resize(columns: number, rows: number, atMs: number): void;
}

/** Awaited filesystem checkpoint seam used by reactive effects. */
export interface ProcessReactiveCheckpoints {
  captureAndRead(
    name: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly index: number;
    readonly checkpoint: FilesystemCheckpoint;
  }>;
}

/** Host dependencies for journal-backed reactive process actions. */
export interface ProcessReactiveEffectHost {
  readonly terminal: () => ProcessReactiveTerminal | undefined;
  readonly renderer: ProcessReactiveRenderer;
  readonly checkpoints: ProcessReactiveCheckpoints;
  readonly interactions: InteractionEvent[];
  readonly journal: ProcessCaptureJournal;
  readonly startedAtMs: number;
  readonly now: () => number;
}

const elapsed = (host: ProcessReactiveEffectHost): number =>
  Math.max(0, host.now() - host.startedAtMs);

const interactionData = (
  action: Exclude<ProcessReactiveAction, { readonly type: "checkpoint" }>,
): string => {
  if (action.type === "send_input")
    return action.sensitive
      ? `<redacted-input:${String(Buffer.byteLength(action.data))}-bytes>`
      : action.data;
  if (action.type === "resize")
    return `${String(action.columns)}x${String(action.rows)}`;
  return action.signal;
};

const interactionType = (
  action: Exclude<ProcessReactiveAction, { readonly type: "checkpoint" }>,
): InteractionEvent["type"] => {
  if (action.type === "send_input") return "input";
  if (action.type === "resize") return "resize";
  return "signal";
};

const performTerminalAction = (
  terminal: ProcessReactiveTerminal,
  renderer: ProcessReactiveRenderer,
  action: Exclude<ProcessReactiveAction, { readonly type: "checkpoint" }>,
  atMs: number,
): void => {
  if (action.type === "send_input") terminal.write(action.data);
  else if (action.type === "resize") {
    terminal.resize(action.columns, action.rows);
    renderer.resize(action.columns, action.rows, atMs);
  } else terminal.kill(action.signal);
};

const recordInteraction = (
  host: ProcessReactiveEffectHost,
  action: Exclude<ProcessReactiveAction, { readonly type: "checkpoint" }>,
  atMs: number,
  outcome: InteractionEvent["outcome"],
): ProcessReactiveEffectResult => {
  const index = host.interactions.length;
  const event: InteractionEvent = {
    sequence: index,
    scheduled_at_ms: atMs,
    dispatched_at_ms: atMs,
    type: interactionType(action),
    data: interactionData(action),
    outcome,
  };
  host.interactions.push(event);
  const location = host.journal.record("interaction_events", index);
  if (outcome !== "dispatched") return { status: "rejected" };
  return {
    status: "succeeded",
    observation: createProcessObservation({
      source: "interaction",
      source_sequence: index,
      captured_at_ms: atMs,
      subject_id: null,
      location,
      payload: event,
    }),
  };
};

const executeTerminalAction = (
  host: ProcessReactiveEffectHost,
  action: Exclude<ProcessReactiveAction, { readonly type: "checkpoint" }>,
): ProcessReactiveEffectResult => {
  if (action.type === "send_signal" && action.target.kind !== "root")
    return { status: "rejected" };
  const terminal = host.terminal();
  if (terminal === undefined) return { status: "target_lost" };
  const atMs = elapsed(host);
  let outcome: InteractionEvent["outcome"] = "dispatched";
  try {
    performTerminalAction(terminal, host.renderer, action, atMs);
  } catch {
    outcome = "failed";
  }
  return recordInteraction(host, action, atMs, outcome);
};

const executeCheckpoint = async (
  host: ProcessReactiveEffectHost,
  action: Extract<ProcessReactiveAction, { readonly type: "checkpoint" }>,
  signal: AbortSignal,
): Promise<ProcessReactiveEffectResult> => {
  try {
    const { index, checkpoint } = await host.checkpoints.captureAndRead(
      action.name,
      signal,
    );
    const location = host.journal.entries.findLast(
      (entry) =>
        entry.collection === "filesystem_checkpoints" && entry.index === index,
    );
    if (location === undefined) return { status: "rejected" };
    return {
      status: "succeeded",
      observation: createProcessObservation({
        source: "filesystem",
        source_sequence: index,
        captured_at_ms: checkpoint.at_ms,
        subject_id: `checkpoint:${checkpoint.name}`,
        location,
        payload: checkpoint,
      }),
    };
  } catch {
    return { status: "rejected" };
  }
};

/** Execute proposed effects in order and stop after the first failure. */
export const executeProcessReactiveEffects = async (
  host: ProcessReactiveEffectHost,
  actions: readonly ProcessReactiveAction[],
  signal: AbortSignal,
): Promise<readonly ProcessReactiveEffectResult[]> => {
  const results: ProcessReactiveEffectResult[] = [];
  for (const action of actions) {
    if (signal.aborted) return results;
    const result =
      action.type === "checkpoint"
        ? await executeCheckpoint(host, action, signal)
        : executeTerminalAction(host, action);
    results.push(result);
    if (result.status !== "succeeded") break;
  }
  return results;
};

const triggerSources = (
  trigger: ProcessReactiveScenario["states"][number]["on"][number]["when"],
): readonly string[] => {
  if (trigger.kind === "terminal_text") return [];
  if (trigger.kind === "event")
    return [
      "terminal_raw",
      "interaction",
      "process",
      "filesystem",
      "http",
      "websocket",
      "shim",
    ].includes(trigger.source)
      ? []
      : [trigger.source];
  return trigger.kind === "repeat"
    ? triggerSources(trigger.trigger)
    : trigger.triggers.flatMap(triggerSources);
};

/** Return unsupported sources, selectors, and checkpoint collisions pre-launch. */
export const unsupportedProcessReactiveFeatures = (
  scenario: ProcessReactiveScenario,
  reservedCheckpointNames: ReadonlySet<string> = new Set([
    "before",
    "after_settlement",
  ]),
): readonly string[] => [
  ...scenario.states.flatMap((state) =>
    state.on.flatMap((transition) =>
      triggerSources(transition.when).map(
        (source) => `${transition.id}:source:${source}`,
      ),
    ),
  ),
  ...scenario.states.flatMap((state) =>
    state.on.flatMap((transition) =>
      transition.actions.flatMap((action) => {
        if (action.type === "send_signal" && action.target.kind !== "root")
          return [`${transition.id}:target:${action.target.kind}`];
        if (
          action.type === "checkpoint" &&
          reservedCheckpointNames.has(action.name)
        )
          return [`${transition.id}:checkpoint:${action.name}`];
        return [];
      }),
    ),
  ),
];
