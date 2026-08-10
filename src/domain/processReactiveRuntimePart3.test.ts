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
  PROCESS_REACTIVE_LIMITS,
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
    deadline_ms: 30_000,
    states: [
      {
        id: "starting",
        max_visits: 4,
        deadline_ms: 5_000,
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
  it("preserves overflow when no any branch matches", () => {
    const scenario = scenarioWith([
      finish("bounded_any", {
        kind: "any",
        triggers: [
          terminalTrigger("never"),
          {
            kind: "event",
            source: "shim",
            exact: { name: "also-never" },
            ignore_fields: [],
            since: { kind: "scenario_start" },
            consume: false,
            cardinality: { min: 1, max: 1 },
          },
        ],
      }),
    ]);
    const decision = reduceProcessReactiveScenario(
      scenario,
      createProcessReactiveSnapshot(scenario),
      {
        kind: "observation",
        observation: observation("terminal_raw", 0, {
          data: "x".repeat(PROCESS_REACTIVE_LIMITS.evaluationWork + 1),
        }),
      },
    );
    expect(decision).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
  });
  it("fails closed at the deterministic per-reduction work budget", () => {
    const transitions = Array.from(
      { length: PROCESS_REACTIVE_LIMITS.predicates },
      (_, index) =>
        finish(`event_${String(index)}`, {
          kind: "event",
          source: "shim",
          exact: { name: `expected_${String(index)}` },
          ignore_fields: ["sequence"],
          since: { kind: "scenario_start" },
          consume: false,
          cardinality: { min: 1, max: 1 },
        }),
    );
    const scenario = scenarioWith(transitions);
    const retained = Array.from({ length: 128 }, (_, order) =>
      observation("shim", order, { name: "other", sequence: order }),
    );
    const snapshot = {
      ...createProcessReactiveSnapshot(scenario),
      observations: retained,
    };
    const decision = offer(
      scenario,
      snapshot,
      observation("shim", retained.length, {
        name: "other",
        sequence: retained.length,
      }),
    );
    expect(decision).toMatchObject({
      kind: "finished",
      outcome: "capture_incomplete",
    });
  });
});
