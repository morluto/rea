import { describe, expect, it } from "vitest";
import {
  ProcessReactiveCoordinator,
  type ProcessReactiveTimerHost,
} from "./ProcessReactiveCoordinator.js";
import { createProcessObservation } from "../domain/processObservation.js";
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
