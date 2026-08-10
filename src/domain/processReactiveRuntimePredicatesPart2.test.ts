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
  it("rejects an exhausted state visit before proposing effects", () => {
    const scenario = processReactiveScenarioSchema.parse({
      version: 1,
      initial_state: "loop",
      deadline_ms: 30000,
      states: [
        {
          id: "loop",
          max_visits: 1,
          deadline_ms: 5000,
          on: [
            {
              ...finish("again", terminalTrigger(), 100, [
                {
                  type: "send_signal",
                  target: { kind: "root" },
                  signal: "SIGKILL",
                },
              ]),
              target: { kind: "goto", state: "loop" },
            },
          ],
        },
      ],
    });
    const decision = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, { data: "Ready" }),
      },
    );
    expect(decision).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    expect(decision).not.toHaveProperty("effects");
  });
  it("classifies deadlines and non-monotonic observation input", () => {
    const scenario = scenarioWith([finish("ready", terminalTrigger())]);
    const initial = createProcessReactiveSnapshot(scenario);
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "state_deadline",
        state_id: "starting",
        state_entry_capture_order: 0,
      }),
    ).toMatchObject({ kind: "finished", outcome: "predicate_timeout" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "state_deadline",
        state_id: "previous",
        state_entry_capture_order: 0,
      }),
    ).toMatchObject({ kind: "waiting", snapshot: initial });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "scenario_deadline",
      }),
    ).toMatchObject({ kind: "finished", outcome: "scenario_deadline" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, { kind: "cancelled" }),
    ).toMatchObject({ kind: "finished", outcome: "cancelled" });
    expect(
      reduceProcessReactiveScenario(scenario, initial, {
        kind: "cleanup_failed",
      }),
    ).toMatchObject({ kind: "finished", outcome: "cleanup_failed" });
    const passed = offer(
      scenario,
      initial,
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(
      reduceProcessReactiveScenario(scenario, passed.snapshot, {
        kind: "cleanup_failed",
      }),
    ).toMatchObject({ kind: "finished", outcome: "cleanup_failed" });
    const first = offer(
      scenario,
      initial,
      observation("shim", 1, { name: "later" }),
    );
    const invalid = offer(
      scenario,
      first.snapshot,
      observation("shim", 0, { name: "earlier" }),
    );
    expect(invalid).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    const duplicate = observation("shim", 1, { name: "later" });
    expect(offer(scenario, first.snapshot, duplicate)).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
    expect(
      offer(scenario, first.snapshot, {
        ...duplicate,
        payload: { name: "changed" },
      }),
    ).toMatchObject({ kind: "finished", outcome: "capture_incomplete" });
  });
});
