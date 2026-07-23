import { describe, expect, it } from "vitest";

import {
  createProcessObservation,
  type ProcessObservationSource,
} from "../src/domain/processObservation.js";
import {
  commitProcessReactiveProposal,
  createProcessReactiveSnapshot,
  reduceProcessReactiveScenario,
} from "../src/domain/processReactiveRuntime.js";
import {
  PROCESS_REACTIVE_LIMITS,
  processReactiveScenarioSchema,
  type ProcessReactiveAction,
  type ProcessReactiveScenario,
} from "../src/domain/processReactiveScenario.js";

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
                : "signal",
          data:
            action.type === "send_input"
              ? action.sensitive
                ? `<redacted-input:${String(Buffer.byteLength(action.data))}-bytes>`
                : action.data
              : action.type === "resize"
                ? `${String(action.columns)}x${String(action.rows)}`
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

describe("process reactive runtime", () => {
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
      deadline_ms: 30_000,
      states: [
        {
          id: "one",
          max_visits: 1,
          deadline_ms: 5_000,
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
          deadline_ms: 5_000,
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

  it("rejects an exhausted state visit before proposing effects", () => {
    const scenario = processReactiveScenarioSchema.parse({
      version: 1,
      initial_state: "loop",
      deadline_ms: 30_000,
      states: [
        {
          id: "loop",
          max_visits: 1,
          deadline_ms: 5_000,
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
  });
});
