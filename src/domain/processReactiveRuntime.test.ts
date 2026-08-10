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
describe("process reactive runtime lifecycle", () => {
  it("matches decoded terminal text across PTY chunks and emits declarative effects", () => {
    const scenario = scenarioWith([
      finish("ready", terminalTrigger(), 100, [
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
        { type: "checkpoint", name: "ready" },
      ]),
    ]);
    const first = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, {
        sequence: 0,
        at_ms: 0,
        data: "Re",
      }),
    );
    expect(first.kind).toBe("waiting");
    const second = offer(
      scenario,
      first.snapshot,
      observation("terminal_raw", 1, {
        sequence: 1,
        at_ms: 1,
        data: "ady\n",
      }),
    );
    expect(second.kind).toBe("transition");
    if (second.kind !== "transition") return;
    expect(second.record).toEqual({
      sequence: 0,
      transition_id: "ready",
      state_before: "starting",
      state_after: null,
      outcome: "passed",
      trigger_event_ids: ["obs.frames.0", "obs.frames.1"],
      action_event_ids: [
        "obs.interaction_events.2",
        "obs.filesystem_checkpoints.3",
      ],
      action_types: ["send_signal", "checkpoint"],
    });
  });
  it("treats redaction-shaped live input as ordinary sensitive data", () => {
    const scenario = scenarioWith([
      finish("ready", terminalTrigger(), 100, [
        {
          type: "send_input",
          data: "<redacted-input:1-bytes>",
          sensitive: true,
        },
      ]),
    ]);
    const decision = offer(
      scenario,
      createProcessReactiveSnapshot(scenario),
      observation("terminal_raw", 0, { data: "Ready" }),
    );
    expect(decision).toMatchObject({
      kind: "transition",
      record: { outcome: "passed" },
    });
  });
  it("reports only the minimal terminal chunk span containing the occurrence", () => {
    const scenario = scenarioWith([finish("ready", terminalTrigger())]);
    let snapshot = createProcessReactiveSnapshot(scenario);
    for (const [order, data] of ["unrelated\n", "Re"].entries()) {
      const decision = offer(
        scenario,
        snapshot,
        observation("terminal_raw", order, { data }),
      );
      expect(decision.kind).toBe("waiting");
      snapshot = decision.snapshot;
    }
    const matched = offer(
      scenario,
      snapshot,
      observation("terminal_raw", 2, { data: "ady" }),
    );
    expect(matched.kind).toBe("transition");
    if (matched.kind === "transition")
      expect(matched.record.trigger_event_ids).toEqual([
        "obs.frames.1",
        "obs.frames.2",
      ]);
  });
});
