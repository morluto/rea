import { describe, expect, it } from "vitest";
import {
  ProcessReactiveCoordinator,
  type ProcessReactiveTimerHost,
} from "./ProcessReactiveCoordinator.js";
import { unsupportedProcessReactiveFeatures } from "./ProcessReactiveEffects.js";
import { createProcessObservation } from "../domain/processObservation.js";
import type { ProcessReactiveEffectResult } from "../domain/processReactiveRuntime.js";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveScenario,
} from "../domain/processReactiveScenario.js";
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
    deadline_ms: 30000,
    states: [
      {
        id: "starting",
        max_visits: 1,
        deadline_ms: 5000,
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
        deadline_ms: 5000,
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
describe("process reactive coordinator failures", () => {
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
});
