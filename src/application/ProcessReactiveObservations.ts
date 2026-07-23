import type {
  InteractionEvent,
  FilesystemCheckpoint,
  ProcessCaptureEventJournalEntry,
  ProcessSample,
  ProtocolEvent,
  ShimEvent,
  TerminalFrame,
} from "../domain/processCapture.js";
import {
  createProcessObservation,
  processObservationSubject,
  type ProcessObservation,
} from "../domain/processObservation.js";
import type { ProcessReactiveInput } from "../domain/processReactiveRuntime.js";
import type { ProcessCaptureJournal } from "./ProcessCaptureJournal.js";

/** Non-blocking input seam implemented by the reactive coordinator. */
export interface ProcessReactiveObservationSink {
  enqueue(input: ProcessReactiveInput): void;
}

interface ProcessReactiveObservationOptions {
  readonly journal: ProcessCaptureJournal;
  readonly frames: readonly TerminalFrame[];
  readonly interactions: readonly InteractionEvent[];
  readonly checkpointAt: (index: number) => FilesystemCheckpoint | undefined;
  readonly processSampleAt: (index: number) => ProcessSample | undefined;
  readonly protocolEventAt: (index: number) => ProtocolEvent | undefined;
  readonly shimEventAt: (index: number) => ShimEvent | undefined;
  readonly sink: ProcessReactiveObservationSink;
}

const terminalObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const value = options.frames[entry.index];
  return value === undefined
    ? undefined
    : createProcessObservation({
        source: "terminal_raw",
        source_sequence: value.sequence,
        captured_at_ms: value.at_ms,
        subject_id: null,
        location: entry,
        payload: value,
      });
};

const interactionObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const value = options.interactions[entry.index];
  return value === undefined
    ? undefined
    : createProcessObservation({
        source: "interaction",
        source_sequence: value.sequence,
        captured_at_ms: value.dispatched_at_ms,
        subject_id: null,
        location: entry,
        payload: value,
      });
};

const filesystemObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const value = options.checkpointAt(entry.index);
  return value === undefined
    ? undefined
    : createProcessObservation({
        source: "filesystem",
        source_sequence: entry.index,
        captured_at_ms: value.at_ms,
        subject_id: processObservationSubject("filesystem", value),
        location: entry,
        payload: value,
      });
};

const processObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const value = options.processSampleAt(entry.index);
  return value === undefined
    ? undefined
    : createProcessObservation({
        source: "process",
        source_sequence: entry.index,
        captured_at_ms: value.at_ms,
        subject_id: processObservationSubject("process", value),
        location: entry,
        payload: value,
      });
};

const protocolObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const value = options.protocolEventAt(entry.index);
  return value === undefined
    ? undefined
    : createProcessObservation({
        source: value.protocol,
        source_sequence: value.sequence,
        captured_at_ms: value.at_ms,
        subject_id: processObservationSubject(value.protocol, value),
        location: entry,
        payload: value,
      });
};

const shimObservation = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  const normalized = options.shimEventAt(entry.index);
  if (normalized === undefined) return undefined;
  return createProcessObservation({
    source: "shim",
    source_sequence: normalized.sequence,
    captured_at_ms: normalized.at_ms,
    subject_id: processObservationSubject("shim", normalized),
    location: entry,
    payload: normalized,
  });
};

const observationFor = (
  options: ProcessReactiveObservationOptions,
  entry: ProcessCaptureEventJournalEntry,
): ProcessObservation | undefined => {
  if (entry.collection === "frames") return terminalObservation(options, entry);
  if (entry.collection === "interaction_events")
    return interactionObservation(options, entry);
  if (entry.collection === "filesystem_checkpoints")
    return filesystemObservation(options, entry);
  if (entry.collection === "process_samples")
    return processObservation(options, entry);
  if (entry.collection === "protocol_events")
    return protocolObservation(options, entry);
  if (entry.collection === "shim_events")
    return shimObservation(options, entry);
  return undefined;
};

/** Subscribe the reactive coordinator to admitted normalized journal records. */
export const subscribeProcessReactiveObservations = (
  options: ProcessReactiveObservationOptions,
): (() => void) => {
  const enqueue = (entry: ProcessCaptureEventJournalEntry): void => {
    const observation = observationFor(options, entry);
    if (observation !== undefined)
      options.sink.enqueue({ kind: "observation", observation });
  };
  for (const entry of options.journal.entries) enqueue(entry);
  return options.journal.subscribe(enqueue);
};
