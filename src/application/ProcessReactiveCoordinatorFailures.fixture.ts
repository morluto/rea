import type { ProcessReactiveTimerHost } from "./ProcessReactiveCoordinator.js";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveScenario,
} from "../domain/processReactiveScenario.js";

export const terminalTrigger = () => ({
  kind: "terminal_text" as const,
  literal: "Ready",
  occurrence: 1,
  since: { kind: "scenario_start" as const },
  consume: true,
});
export const timerHost = () => {
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
export const twoStateScenario = (): ProcessReactiveScenario =>
  processReactiveScenarioSchema.parse({
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
            actions: [{ type: "send_input", data: "go" }],
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
            target: { kind: "finish" },
          },
        ],
      },
    ],
  });
