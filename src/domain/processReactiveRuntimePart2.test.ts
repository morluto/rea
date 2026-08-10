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
describe("process reactive runtime lifecycle", () => {
  it("does not commit state, checkpoints, consumption, or history before effects succeed", () => {
    const scenario = scenarioWith([
      finish("ready", { ...terminalTrigger(), consume: true }, 100, [
        { type: "checkpoint", name: "ready" },
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
      ]),
    ]);
    const proposed = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, { data: "Ready" }),
      },
    );
    expect(proposed.kind).toBe("proposal");
    if (proposed.kind !== "proposal") return;
    expect(proposed.snapshot).toMatchObject({
      status: "running",
      checkpoints: [],
      consumed_event_ids: [],
      transitions: [],
    });
    const rejected = commitProcessReactiveProposal(scenario, proposed, [
      {
        status: "succeeded",
        observation: observation("filesystem", 1, { name: "ready" }),
      },
      { status: "rejected" },
    ]);
    expect(rejected).toMatchObject({
      kind: "finished",
      outcome: "action_rejected",
      snapshot: {
        checkpoints: [],
        consumed_event_ids: [],
        transitions: [],
      },
    });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        { status: "target_lost" },
        {
          status: "succeeded",
          observation: observation("interaction", 2, {
            type: "signal",
            data: "SIGINT",
            outcome: "dispatched",
          }),
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "target_lost" });
    const committed = commitProcessReactiveProposal(scenario, proposed, [
      {
        status: "succeeded",
        observation: observation("filesystem", 1, { name: "ready" }),
      },
      {
        status: "succeeded",
        observation: observation("interaction", 2, {
          type: "signal",
          data: "SIGINT",
          outcome: "dispatched",
        }),
      },
    ]);
    expect(committed.snapshot).toMatchObject({
      checkpoints: [
        {
          name: "ready",
          event_id: "obs.filesystem_checkpoints.1",
          capture_order: 1,
        },
      ],
    });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        {
          status: "succeeded",
          observation: observation("filesystem", 1, { name: "other" }),
        },
        {
          status: "succeeded",
          observation: observation("interaction", 2, {
            type: "signal",
            data: "SIGINT",
            outcome: "dispatched",
          }),
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "action_rejected" });
    const changedScenario = scenarioWith([
      finish("ready", { ...terminalTrigger(), consume: true }, 100, [
        { type: "checkpoint", name: "changed" },
        { type: "send_signal", target: { kind: "root" }, signal: "SIGINT" },
      ]),
    ]);
    expect(
      commitProcessReactiveProposal(changedScenario, proposed, [
        succeededEffect({ type: "checkpoint", name: "ready" }, 1),
        succeededEffect(
          {
            type: "send_signal",
            target: { kind: "root" },
            signal: "SIGINT",
          },
          2,
        ),
      ]),
    ).toMatchObject({ kind: "finished", outcome: "target_lost" });
    expect(
      commitProcessReactiveProposal(scenario, proposed, [
        {
          status: "succeeded",
          observation: observation("filesystem", 1, { name: "ready" }),
        },
        {
          status: "succeeded",
          observation: {
            ...observation("filesystem", 2, { name: "ready" }),
            event_id: "obs.filesystem_checkpoints.1",
          },
        },
      ]),
    ).toMatchObject({ kind: "finished", outcome: "action_rejected" });
  });
});
