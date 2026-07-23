import { describe, expect, it } from "vitest";

import {
  ProcessReactiveCoordinator,
  type ProcessReactiveTimerHost,
} from "../src/application/ProcessReactiveCoordinator.js";
import {
  executeProcessReactiveEffects,
  unsupportedProcessReactiveFeatures,
} from "../src/application/ProcessReactiveEffects.js";
import { createProcessCaptureJournal } from "../src/application/ProcessCaptureJournal.js";
import { subscribeProcessReactiveObservations } from "../src/application/ProcessReactiveObservations.js";
import type {
  FilesystemCheckpoint,
  InteractionEvent,
  TerminalFrame,
} from "../src/domain/processCapture.js";
import { createProcessObservation } from "../src/domain/processObservation.js";
import type { ProcessReactiveEffectResult } from "../src/domain/processReactiveRuntime.js";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveScenario,
} from "../src/domain/processReactiveScenario.js";

const terminalTrigger = () => ({
  kind: "terminal_text" as const,
  view: "decoded" as const,
  encoding: "utf8" as const,
  literal: "Ready",
  case_sensitive: true,
  control_sequences: "include" as const,
  occurrence: 1,
  since: { kind: "scenario_start" as const },
  consume: true,
});

const timerHost = () => {
  const scheduled: Array<{
    readonly callback: () => void;
    readonly delayMs: number;
    cancelled: boolean;
  }> = [];
  const host: ProcessReactiveTimerHost = {
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  return { host, scheduled };
};

const twoStateScenario = (): ProcessReactiveScenario =>
  processReactiveScenarioSchema.parse({
    version: 1,
    initial_state: "starting",
    deadline_ms: 30_000,
    states: [
      {
        id: "starting",
        max_visits: 1,
        deadline_ms: 5_000,
        on: [
          {
            id: "send",
            priority: 1,
            max_uses: 1,
            when: terminalTrigger(),
            actions: [{ type: "send_input", data: "go", sensitive: false }],
            target: { kind: "goto", state: "sent" },
          },
        ],
      },
      {
        id: "sent",
        max_visits: 1,
        deadline_ms: 5_000,
        on: [
          {
            id: "confirm",
            priority: 1,
            max_uses: 1,
            when: {
              kind: "event",
              source: "interaction",
              exact: { type: "input", data: "go", outcome: "dispatched" },
              ignore_fields: [
                "sequence",
                "scheduled_at_ms",
                "dispatched_at_ms",
              ],
              since: { kind: "scenario_start" },
              consume: true,
              cardinality: { min: 1, max: 1 },
            },
            actions: [],
            target: { kind: "finish", outcome: "passed" },
          },
        ],
      },
    ],
  });

const createHarness = (scenario: ProcessReactiveScenario) => {
  const journal = createProcessCaptureJournal();
  const frames: TerminalFrame[] = [];
  const interactions: InteractionEvent[] = [];
  const checkpoints: FilesystemCheckpoint[] = [];
  const terminalCalls: string[] = [];
  const timers = timerHost();
  let now = 100;
  const effectHost = {
    terminal: () => ({
      write: (data: string) => terminalCalls.push(`write:${data}`),
      resize: (columns: number, rows: number) =>
        terminalCalls.push(`resize:${String(columns)}x${String(rows)}`),
      kill: (signal: "SIGINT" | "SIGTERM" | "SIGKILL") =>
        terminalCalls.push(`kill:${signal}`),
    }),
    renderer: {
      resize: (columns: number, rows: number) =>
        terminalCalls.push(`render:${String(columns)}x${String(rows)}`),
    },
    checkpoints: {
      captureAndRead: async (name: string) => {
        const index = checkpoints.length;
        const checkpoint: FilesystemCheckpoint = {
          name,
          at_ms: now - 100,
          files: [],
          effects: [],
          truncated: false,
        };
        checkpoints.push(checkpoint);
        journal.record("filesystem_checkpoints", index);
        return { index, checkpoint };
      },
    },
    interactions,
    journal,
    startedAtMs: 100,
    now: () => now,
  };
  const coordinator = new ProcessReactiveCoordinator({
    scenario,
    executor: {
      execute: (actions, signal) =>
        executeProcessReactiveEffects(effectHost, actions, signal),
    },
    timerHost: timers.host,
  });
  const unsubscribe = subscribeProcessReactiveObservations({
    journal,
    frames,
    interactions,
    checkpointAt: (index) => checkpoints[index],
    processSampleAt: () => undefined,
    protocolEventAt: () => undefined,
    shimEventAt: () => undefined,
    sink: coordinator,
  });
  return {
    coordinator,
    frames,
    interactions,
    checkpoints,
    journal,
    terminalCalls,
    timers: timers.scheduled,
    setNow: (value: number) => (now = value),
    unsubscribe,
  };
};

describe("process reactive coordinator", () => {
  it("commits terminal effects before evaluating their journal observations", async () => {
    const harness = createHarness(twoStateScenario());
    harness.frames.push({ sequence: 0, at_ms: 0, data: "Ready" });
    harness.journal.record("frames", 0);

    await harness.coordinator.drain();

    expect(harness.coordinator.snapshot).toMatchObject({
      status: "finished",
      outcome: "passed",
      active_state: "sent",
    });
    expect(
      harness.coordinator.snapshot.transitions.map(
        ({ transition_id }) => transition_id,
      ),
    ).toEqual(["send", "confirm"]);
    expect(harness.terminalCalls).toEqual(["write:go"]);
    expect(harness.journal.entries).toEqual([
      { collection: "frames", index: 0, capture_order: 0 },
      { collection: "interaction_events", index: 0, capture_order: 1 },
    ]);
    expect(harness.interactions[0]).toMatchObject({
      type: "input",
      data: "go",
      outcome: "dispatched",
    });
    harness.unsubscribe();
    await harness.coordinator.close();
  });

  it("executes input, resize, root signal, and checkpoint in journal order", async () => {
    const scenario = processReactiveScenarioSchema.parse({
      version: 1,
      initial_state: "ready",
      deadline_ms: 30_000,
      states: [
        {
          id: "ready",
          max_visits: 1,
          deadline_ms: 5_000,
          on: [
            {
              id: "act",
              priority: 1,
              max_uses: 1,
              when: terminalTrigger(),
              actions: [
                { type: "send_input", data: "secret", sensitive: true },
                { type: "resize", columns: 100, rows: 40 },
                {
                  type: "send_signal",
                  target: { kind: "root" },
                  signal: "SIGINT",
                },
                { type: "checkpoint", name: "stopped" },
              ],
              target: { kind: "finish", outcome: "passed" },
            },
          ],
        },
      ],
    });
    const harness = createHarness(scenario);
    harness.setNow(125);
    harness.frames.push({ sequence: 0, at_ms: 20, data: "Ready" });
    harness.journal.record("frames", 0);

    await harness.coordinator.drain();

    expect(harness.terminalCalls).toEqual([
      "write:secret",
      "resize:100x40",
      "render:100x40",
      "kill:SIGINT",
    ]);
    expect(harness.interactions.map(({ data }) => data)).toEqual([
      "<redacted-input:6-bytes>",
      "100x40",
      "SIGINT",
    ]);
    expect(harness.checkpoints).toHaveLength(1);
    expect(
      harness.coordinator.snapshot.transitions[0]?.action_event_ids,
    ).toEqual([
      "obs.interaction_events.0",
      "obs.interaction_events.1",
      "obs.interaction_events.2",
      "obs.filesystem_checkpoints.0",
    ]);
    await harness.coordinator.close();
  });

  it("ignores a stale state timer after a transition", async () => {
    const base = twoStateScenario();
    const first = base.states[0];
    const second = base.states[1];
    if (first === undefined || second === undefined)
      throw new Error("two-state fixture is incomplete");
    const scenario = processReactiveScenarioSchema.parse({
      ...base,
      states: [
        {
          ...first,
          on: first.on.map((transition) => ({
            ...transition,
            actions: [],
          })),
        },
        {
          ...second,
          on: second.on.map((transition) => ({
            ...transition,
            when: { ...terminalTrigger(), literal: "Later" },
          })),
        },
      ],
    });
    const harness = createHarness(scenario);
    const oldStateTimer = harness.timers[1];
    expect(oldStateTimer?.delayMs).toBe(5_000);
    harness.frames.push({ sequence: 0, at_ms: 0, data: "Ready" });
    harness.journal.record("frames", 0);
    await harness.coordinator.drain();
    expect(oldStateTimer?.cancelled).toBe(true);

    oldStateTimer?.callback();
    await harness.coordinator.drain();

    expect(harness.coordinator.snapshot).toMatchObject({
      status: "running",
      active_state: "sent",
      outcome: null,
    });
    const currentStateTimer = harness.timers[2];
    currentStateTimer?.callback();
    await harness.coordinator.drain();
    expect(harness.coordinator.snapshot.outcome).toBe("predicate_timeout");
    await harness.coordinator.close();
  });

  it("preflights signal selectors the host cannot execute", () => {
    const input = twoStateScenario();
    const first = input.states[0];
    const second = input.states[1];
    const transition = first?.on[0];
    if (first === undefined || second === undefined || transition === undefined)
      throw new Error("two-state fixture is incomplete");
    const scenario = processReactiveScenarioSchema.parse({
      ...input,
      states: [
        {
          ...first,
          on: [
            {
              ...transition,
              actions: [
                {
                  type: "send_signal",
                  target: { kind: "process_group" },
                  signal: "SIGTERM",
                },
              ],
            },
          ],
        },
        second,
      ],
    });
    expect(unsupportedProcessReactiveFeatures(scenario)).toEqual([
      "send:target:process_group",
    ]);
  });

  it("orders delayed effect observations before later producer records", async () => {
    const timers = timerHost();
    let executions = 0;
    let resolveEffects:
      | ((results: readonly ProcessReactiveEffectResult[]) => void)
      | undefined;
    const effects = new Promise<readonly ProcessReactiveEffectResult[]>(
      (resolve) => (resolveEffects = resolve),
    );
    const coordinator = new ProcessReactiveCoordinator({
      scenario: twoStateScenario(),
      executor: {
        execute: () => {
          executions += 1;
          return executions === 1 ? effects : Promise.resolve([]);
        },
      },
      timerHost: timers.host,
    });
    coordinator.enqueue({
      kind: "observation",
      observation: createProcessObservation({
        source: "terminal_raw",
        source_sequence: 0,
        captured_at_ms: 0,
        subject_id: null,
        location: { collection: "frames", index: 0, capture_order: 0 },
        payload: { sequence: 0, at_ms: 0, data: "Ready" },
      }),
    });
    await Promise.resolve();
    coordinator.enqueue({
      kind: "observation",
      observation: createProcessObservation({
        source: "terminal_raw",
        source_sequence: 1,
        captured_at_ms: 2,
        subject_id: null,
        location: { collection: "frames", index: 1, capture_order: 2 },
        payload: { sequence: 1, at_ms: 2, data: "later" },
      }),
    });
    if (resolveEffects === undefined)
      throw new Error("effect executor did not start");
    resolveEffects([
      {
        status: "succeeded",
        observation: createProcessObservation({
          source: "interaction",
          source_sequence: 0,
          captured_at_ms: 1,
          subject_id: null,
          location: {
            collection: "interaction_events",
            index: 0,
            capture_order: 1,
          },
          payload: {
            sequence: 0,
            scheduled_at_ms: 1,
            dispatched_at_ms: 1,
            type: "input",
            data: "go",
            outcome: "dispatched",
          },
        }),
      },
    ]);

    await coordinator.drain();

    expect(coordinator.snapshot).toMatchObject({
      status: "finished",
      outcome: "passed",
    });
    expect(
      coordinator.snapshot.transitions.map(
        ({ transition_id }) => transition_id,
      ),
    ).toEqual(["send", "confirm"]);
    await coordinator.close();
  });

  it("cancels timers and rejects later work after an executor failure", async () => {
    const timers = timerHost();
    let calls = 0;
    const coordinator = new ProcessReactiveCoordinator({
      scenario: twoStateScenario(),
      executor: {
        execute: () => {
          calls += 1;
          throw new Error("executor failed");
        },
      },
      timerHost: timers.host,
    });
    const ready = createProcessObservation({
      source: "terminal_raw",
      source_sequence: 0,
      captured_at_ms: 0,
      subject_id: null,
      location: { collection: "frames", index: 0, capture_order: 0 },
      payload: { sequence: 0, at_ms: 0, data: "Ready" },
    });
    coordinator.enqueue({ kind: "observation", observation: ready });
    await expect(coordinator.drain()).rejects.toThrow("executor failed");
    coordinator.enqueue({ kind: "observation", observation: ready });
    expect(calls).toBe(1);
    expect(timers.scheduled.every(({ cancelled }) => cancelled)).toBe(true);
  });

  it("aborts an in-flight effect before committing a state deadline", async () => {
    const timers = timerHost();
    let effectAborted = false;
    const coordinator = new ProcessReactiveCoordinator({
      scenario: twoStateScenario(),
      executor: {
        execute: (_actions, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                effectAborted = true;
                resolve([]);
              },
              { once: true },
            );
          }),
      },
      timerHost: timers.host,
    });
    coordinator.enqueue({
      kind: "observation",
      observation: createProcessObservation({
        source: "terminal_raw",
        source_sequence: 0,
        captured_at_ms: 0,
        subject_id: null,
        location: { collection: "frames", index: 0, capture_order: 0 },
        payload: { sequence: 0, at_ms: 0, data: "Ready" },
      }),
    });
    await Promise.resolve();
    timers.scheduled[1]?.callback();

    await coordinator.drain();

    expect(effectAborted).toBe(true);
    expect(coordinator.snapshot).toMatchObject({
      status: "finished",
      outcome: "predicate_timeout",
      active_state: "starting",
      transitions: [],
    });
    await coordinator.close();
  });
});
