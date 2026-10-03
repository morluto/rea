import { describe, expect, it } from "vitest";
import { ProcessReactiveCoordinator } from "./ProcessReactiveCoordinator.js";
import { unsupportedProcessReactiveFeatures } from "./ProcessReactiveEffects.js";
import { createProcessObservation } from "../domain/processObservation.js";
import type { ProcessReactiveEffectResult } from "../domain/processReactiveRuntime.js";
import { processReactiveScenarioSchema } from "../domain/processReactiveScenario.js";
import {
  timerHost,
  twoStateScenario,
} from "./ProcessReactiveCoordinatorFailures.fixture.js";

describe("process reactive coordinator failures: host preflight and ordering", () => {
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

describe("process reactive coordinator failures: effect deadlines", () => {
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
