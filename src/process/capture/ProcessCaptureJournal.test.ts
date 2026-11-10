import { expect, it, vi } from "vitest";

import {
  createProcessCaptureJournal,
  scheduleScenarioInteractions,
} from "./ProcessCaptureJournal.js";

import { TerminalRenderer } from "./TerminalRenderer.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import type { InteractionEvent } from "../../domain/process/processCapture.js";
import type { ProcessTimer } from "./ProcessTimer.js";

it("records capture events in monotonic observation order", () => {
  const journal = createProcessCaptureJournal();
  journal.recordEvent("filesystem_checkpoints", 0);
  journal.recordEvent("lifecycle", 0);
  journal.recordEvent("frames", 0);
  journal.recordEvent("filesystem_checkpoints", 1);

  expect(journal.entries).toEqual([
    { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 0 },
    { capture_order: 2, collection: "frames", index: 0 },
    { capture_order: 3, collection: "filesystem_checkpoints", index: 1 },
  ]);
});

it.each([true, false])(
  "preserves non-path input markers when paths=%s",
  async (paths) => {
    vi.useFakeTimers();
    const value = "x <no-temporary-root> y\n";
    const scenario = processScenarioSchema.parse({
      executable: "/usr/bin/node",
      working_directory: "/workspace",
      events: [{ type: "input", at_ms: 0, data: value }],
      normalization: { paths, pids: false, ports: false, patterns: [] },
    });
    const renderer = new TerminalRenderer({
      columns: 80,
      rows: 24,
      scrollback: 0,
      maxBytes: 1024,
      normalize: (value) => ({
        state: "normalized",
        value,
        utf8Bytes: Buffer.byteLength(value),
      }),
    });
    const timers = new Set<ProcessTimer>();
    const interactions: InteractionEvent[] = [];
    const journal = createProcessCaptureJournal();
    try {
      scheduleScenarioInteractions({
        scenario,
        getTerminal: () => undefined,
        timers,
        interactions,
        renderer,
        started: 0,
        dispatchedEventIndexes: new Set(),
        recordEvent: journal.recordEvent,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(interactions).toHaveLength(1);
      expect(interactions[0]).toMatchObject({
        type: "input",
        data: value,
        outcome: "target_exited",
      });
      expect(journal.entries).toEqual([
        { capture_order: 0, collection: "interaction_events", index: 0 },
      ]);
    } finally {
      for (const timer of timers) timer.cancel();
      await renderer.dispose();
      vi.useRealTimers();
    }
  },
);
