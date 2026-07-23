import type {
  ProcessCaptureEventJournalEntry,
  TerminalFrame,
} from "../domain/processCapture.js";
import { createProcessObservation } from "../domain/processObservation.js";
import type { ProcessReactiveInput } from "../domain/processReactiveRuntime.js";
import type { ProcessCaptureJournal } from "./ProcessCaptureJournal.js";

/** Non-blocking input seam implemented by the reactive coordinator. */
export interface ProcessReactiveObservationSink {
  enqueue(input: ProcessReactiveInput): void;
}

/** Subscribe a reactive coordinator to normalized raw PTY journal records. */
export const subscribeProcessReactiveTerminalObservations = (options: {
  readonly journal: ProcessCaptureJournal;
  readonly frames: readonly TerminalFrame[];
  readonly sink: ProcessReactiveObservationSink;
}): (() => void) =>
  options.journal.subscribe((entry: ProcessCaptureEventJournalEntry) => {
    if (entry.collection !== "frames") return;
    const frame = options.frames[entry.index];
    if (frame === undefined) return;
    options.sink.enqueue({
      kind: "observation",
      observation: createProcessObservation({
        source: "terminal_raw",
        source_sequence: frame.sequence,
        captured_at_ms: frame.at_ms,
        subject_id: null,
        location: entry,
        payload: frame,
      }),
    });
  });
