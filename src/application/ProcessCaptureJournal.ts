import type { IPty } from "@lydell/node-pty";

import type {
  InteractionEvent,
  ProcessCaptureEventJournalEntry,
  ProcessScenario,
  RecordProcessCaptureEvent,
} from "../domain/processCapture.js";
import { normalizeProcessText } from "./ProcessNormalization.js";
import type { TerminalRenderer } from "./TerminalRenderer.js";

/** Mutable observation-order ledger whose writer is shared by capture producers. */
export interface ProcessCaptureJournal {
  readonly entries: readonly ProcessCaptureEventJournalEntry[];
  readonly recordEvent: RecordProcessCaptureEvent;
}

/** Create one monotonic event journal for a process capture. */
export const createProcessCaptureJournal = (): ProcessCaptureJournal => {
  const entries: ProcessCaptureEventJournalEntry[] = [];
  return {
    entries,
    recordEvent: (collection, index) => {
      entries.push({ capture_order: entries.length, collection, index });
    },
  };
};

interface ScenarioInteractionOptions {
  readonly scenario: ProcessScenario;
  readonly getTerminal: () => IPty | undefined;
  readonly timers: Set<NodeJS.Timeout>;
  readonly interactions: InteractionEvent[];
  readonly renderer: TerminalRenderer;
  readonly started: number;
  readonly dispatchedEventIndexes: Set<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
}

/** Schedule scenario interactions and record each observed dispatch atomically. */
export const scheduleScenarioInteractions = (
  options: ScenarioInteractionOptions,
): void => {
  const { scenario, getTerminal, timers, interactions, renderer, started } =
    options;
  for (const [eventIndex, event] of scenario.events.entries()) {
    const timer = setTimeout(() => {
      options.dispatchedEventIndexes.add(eventIndex);
      const terminal = getTerminal();
      const dispatchedAt = Math.max(0, Date.now() - started);
      let outcome: InteractionEvent["outcome"] = "dispatched";
      if (terminal === undefined) outcome = "target_exited";
      else {
        try {
          if (event.type === "input") terminal.write(event.data);
          else if (event.type === "resize") {
            terminal.resize(event.columns, event.rows);
            renderer.resize(event.columns, event.rows, dispatchedAt);
          } else terminal.kill(event.signal);
        } catch {
          outcome = "failed";
        }
      }
      const sequence = interactions.length;
      interactions.push({
        sequence,
        scheduled_at_ms: event.at_ms,
        dispatched_at_ms: dispatchedAt,
        type: event.type,
        data:
          event.type === "input"
            ? event.sensitive
              ? `<redacted-input:${String(Buffer.byteLength(event.data))}-bytes>`
              : normalizeProcessText(
                  event.data,
                  scenario,
                  "<no-temporary-root>",
                  -1,
                )
            : event.type === "resize"
              ? `${String(event.columns)}x${String(event.rows)}`
              : event.signal,
        outcome,
      });
      options.recordEvent("interaction_events", sequence);
    }, event.at_ms);
    timers.add(timer);
  }
};
