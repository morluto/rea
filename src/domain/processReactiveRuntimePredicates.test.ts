import { describe, expect, it } from "vitest";
import {
  createProcessObservation,
  type ProcessObservationSource,
} from "./processObservation.js";
import {
  commitProcessReactiveProposal,
  createProcessReactiveSnapshot,
  reduceProcessReactiveScenario,
} from "./processReactiveRuntime.js";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveAction,
  type ProcessReactiveScenario,
} from "./processReactiveScenario.js";
const terminalTrigger = (literal = "Ready") => ({
  kind: "terminal_text" as const,
  view: "decoded" as const,
  encoding: "utf8" as const,
  literal,
  case_sensitive: true,
  control_sequences: "include" as const,
  occurrence: 1,
  since: { kind: "scenario_start" as const },
  consume: false,
});
const scenarioWith = (
  transitions: readonly unknown[],
): ProcessReactiveScenario =>
  processReactiveScenarioSchema.parse({
    version: 1,
    initial_state: "starting",
    deadline_ms: 30000,
    states: [
      {
        id: "starting",
        max_visits: 4,
        deadline_ms: 5000,
        on: transitions,
      },
    ],
  });
const finish = (
  id: string,
  when: unknown,
  priority = 100,
  actions: readonly unknown[] = [],
) => ({
  id,
  priority,
  max_uses: 4,
  when,
  actions,
  target: { kind: "finish", outcome: "passed" },
});
const collectionFor = (source: ProcessObservationSource) => {
  switch (source) {
    case "terminal_raw":
      return "frames" as const;
    case "terminal_rendered":
      return "rendered_frames" as const;
    case "process":
      return "process_samples" as const;
    case "filesystem":
      return "filesystem_checkpoints" as const;
    case "shim":
      return "shim_events" as const;
    case "http":
    case "websocket":
      return "protocol_events" as const;
    case "replay_transition":
      return "replay_transitions" as const;
    case "interaction":
      return "interaction_events" as const;
    case "lifecycle":
      return "lifecycle" as const;
  }
};
const observation = (
  source: ProcessObservationSource,
  order: number,
  payload: unknown,
) =>
  createProcessObservation({
    source,
    source_sequence: order,
    captured_at_ms: order,
    subject_id: null,
    location: {
      collection: collectionFor(source),
      index: order,
      capture_order: order,
    },
    payload,
  });
const succeededEffect = (action: ProcessReactiveAction, order: number) => ({
  status: "succeeded" as const,
  observation:
    action.type === "checkpoint"
      ? observation("filesystem", order, { name: action.name })
      : observation("interaction", order, {
          type:
            action.type === "send_input"
              ? "input"
              : action.type === "resize"
                ? "resize"
                : action.type === "close_stdin"
                  ? "stdin_close"
                  : "signal",
          data:
            action.type === "send_input"
              ? action.sensitive
                ? `<redacted-input:${String(Buffer.byteLength(action.data))}-bytes>`
                : action.data
              : action.type === "resize"
                ? `${String(action.columns)}x${String(action.rows)}`
                : action.type === "close_stdin"
                  ? ""
                  : action.signal,
          outcome: "dispatched",
        }),
});
const offer = (
  scenario: ProcessReactiveScenario,
  snapshot: ReturnType<typeof createProcessReactiveSnapshot>,
  value: ReturnType<typeof observation>,
) => {
  const proposed = reduceProcessReactiveScenario(scenario, snapshot, {
    kind: "observation",
    observation: value,
  });
  return proposed.kind === "proposal"
    ? commitProcessReactiveProposal(
        scenario,
        proposed,
        proposed.effects.map((effect, index) => ({
          ...succeededEffect(
            effect,
            (proposed.snapshot.observations.at(-1)?.capture_order ?? -1) +
              index +
              1,
          ),
        })),
      )
    : proposed;
};
describe("process reactive runtime predicates", () => {
  it("selects a unique priority and reports equal-priority ambiguity", () => {
    const preferred = scenarioWith([
      finish("fallback", terminalTrigger(), 20),
      finish("preferred", terminalTrigger(), 10),
    ]);
    const selected = offer(
      preferred,
      createProcessReactiveSnapshot(preferred),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(selected.kind).toBe("transition");
    if (selected.kind === "transition")
      expect(selected.record.transition_id).toBe("preferred");
    for (const transitions of [
      [finish("one", terminalTrigger()), finish("two", terminalTrigger())],
      [finish("two", terminalTrigger()), finish("one", terminalTrigger())],
    ]) {
      const ambiguous = scenarioWith(transitions);
      const decision = offer(
        ambiguous,
        createProcessReactiveSnapshot(ambiguous),
        observation("terminal_raw", 0, { data: "Ready" }),
      );
      expect(decision).toMatchObject({
        kind: "finished",
        outcome: "ambiguous_match",
      });
    }
  });
  it("evaluates ordered and repeated predicates without array-order arbitration", () => {
    const event = (name: string) => ({
      kind: "event" as const,
      source: "shim" as const,
      exact: { name },
      ignore_fields: ["sequence" as const],
      since: { kind: "scenario_start" as const },
      consume: true,
      cardinality: { min: 1, max: 1 },
    });
    const scenario = scenarioWith([
      finish("sequence", {
        kind: "sequence",
        triggers: [
          event("start"),
          { kind: "repeat", trigger: event("tick"), min: 2, max: 2 },
          event("done"),
        ],
      }),
    ]);
    let snapshot = createProcessReactiveSnapshot(scenario);
    for (const [order, name] of ["start", "tick", "tick"].entries()) {
      const decision = offer(
        scenario,
        snapshot,
        observation("shim", order, { name, sequence: order }),
      );
      expect(decision.kind).toBe("waiting");
      snapshot = decision.snapshot;
    }
    const decision = offer(
      scenario,
      snapshot,
      observation("shim", 3, { name: "done", sequence: 3 }),
    );
    expect(decision.kind).toBe("transition");
    if (decision.kind === "transition")
      expect(decision.record.trigger_event_ids).toEqual([
        "obs.shim_events.0",
        "obs.shim_events.1",
        "obs.shim_events.2",
        "obs.shim_events.3",
      ]);
  });
  it("applies state-entry frontiers and explicit consumption", () => {
    const secondTrigger = {
      ...terminalTrigger(),
      since: { kind: "state_entry" as const },
      consume: true,
    };
    const scenario = processReactiveScenarioSchema.parse({
      version: 1,
      initial_state: "one",
      deadline_ms: 30000,
      states: [
        {
          id: "one",
          max_visits: 1,
          deadline_ms: 5000,
          on: [
            {
              ...finish("advance", terminalTrigger()),
              target: { kind: "goto", state: "two" },
            },
          ],
        },
        {
          id: "two",
          max_visits: 1,
          deadline_ms: 5000,
          on: [finish("finish", secondTrigger)],
        },
      ],
    });
    const advanced = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(advanced.kind).toBe("transition");
    const waiting = offer(
      scenario,
      advanced.snapshot,
      observation("shim", 1, { name: "unrelated" }),
    );
    expect(waiting.kind).toBe("waiting");
    const finished = offer(
      scenario,
      waiting.snapshot,
      observation("terminal_raw", 2, { data: "Ready" }),
    );
    expect(finished.kind).toBe("transition");
    expect(finished.snapshot.consumed_event_ids).toEqual(["obs.frames.2"]);
  });
});
