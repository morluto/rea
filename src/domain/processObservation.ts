import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "./jsonValue.js";
import type { ProcessCapture } from "./processCapture.js";

/** Process-capture observation families shared by live drivers and trace assertions. */
export const processObservationSourceSchema = z.enum([
  "terminal_raw",
  "terminal_rendered",
  "interaction",
  "lifecycle",
  "process",
  "filesystem",
  "http",
  "websocket",
  "shim",
  "replay_transition",
]);
export type ProcessObservationSource = z.infer<
  typeof processObservationSourceSchema
>;

/** Stable raw-record location within one Process Capture observation journal. */
export const processObservationLocationSchema = z.strictObject({
  collection: z.enum([
    "frames",
    "rendered_frames",
    "interaction_events",
    "lifecycle",
    "process_samples",
    "filesystem_checkpoints",
    "shim_events",
    "protocol_events",
    "replay_transitions",
  ]),
  index: z.number().int().nonnegative(),
  capture_order: z.number().int().nonnegative(),
});
export type ProcessObservationLocation = z.infer<
  typeof processObservationLocationSchema
>;

/** Provider-neutral event offered to a reactive scenario or offline assertion. */
export interface ProcessObservation {
  readonly event_id: string;
  readonly source: ProcessObservationSource;
  readonly source_sequence: number;
  readonly capture_order: number;
  readonly captured_at_ms: number | null;
  readonly subject_id: string | null;
  readonly location: ProcessObservationLocation;
  readonly payload: JsonValue;
}

/** Input used by live producers to construct the same observation shape. */
export interface ProcessObservationInput {
  readonly source: ProcessObservationSource;
  readonly source_sequence: number;
  readonly captured_at_ms: number | null;
  readonly subject_id: string | null;
  readonly location: ProcessObservationLocation;
  readonly payload: unknown;
}

/** Remove only explicitly declared top-level volatile fields before matching. */
export const comparableProcessObservationPayload = (
  value: unknown,
  ignoredFields: readonly string[] = [],
): unknown => {
  if (
    ignoredFields.length === 0 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !ignoredFields.includes(name)),
  );
};

/** Construct a validated observation from one live producer record. */
export const createProcessObservation = (
  input: ProcessObservationInput,
): ProcessObservation => ({
  event_id: `obs.${input.location.collection}.${String(input.location.index)}`,
  source: input.source,
  source_sequence: input.source_sequence,
  capture_order: input.location.capture_order,
  captured_at_ms: input.captured_at_ms,
  subject_id: input.subject_id,
  location: input.location,
  payload: jsonValueSchema.parse(input.payload),
});

type ProjectedRecord = Omit<
  ProcessObservation,
  "event_id" | "source_sequence" | "capture_order" | "location"
>;

const atMilliseconds = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null) return null;
  for (const name of ["at_ms", "dispatched_at_ms"])
    if (name in value) {
      const candidate = value[name as keyof typeof value];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate))
        return candidate;
    }
  return null;
};

const subjectFor = (
  source: ProcessObservationSource,
  value: JsonValue,
): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  if (source === "process" && typeof value["pid"] === "number")
    return `process:${String(value["pid"])}`;
  if (source === "filesystem" && typeof value["name"] === "string")
    return `checkpoint:${value["name"]}`;
  return null;
};

const projectedRecord = (
  capture: ProcessCapture,
  location: ProcessObservationLocation,
): ProjectedRecord | null => {
  const projected = (() => {
    switch (location.collection) {
      case "frames":
        return {
          source: "terminal_raw" as const,
          value: capture.frames[location.index],
        };
      case "rendered_frames":
        return {
          source: "terminal_rendered" as const,
          value: capture.rendered_frames[location.index],
        };
      case "interaction_events":
        return {
          source: "interaction" as const,
          value: capture.interaction_events[location.index],
        };
      case "lifecycle":
        return location.index === 0
          ? {
              source: "lifecycle" as const,
              value: { event: "exit", ...capture.exit },
            }
          : location.index === 1
            ? {
                source: "lifecycle" as const,
                value: { event: "settlement", ...capture.settlement },
              }
            : null;
      case "process_samples":
        return {
          source: "process" as const,
          value: capture.process_samples[location.index],
        };
      case "filesystem_checkpoints":
        return {
          source: "filesystem" as const,
          value: capture.filesystem_checkpoints[location.index],
        };
      case "shim_events":
        return {
          source: "shim" as const,
          value: capture.shim_events[location.index],
        };
      case "protocol_events": {
        const event = capture.protocol_events[location.index];
        return event === undefined
          ? null
          : { source: event.protocol, value: event };
      }
      case "replay_transitions":
        return {
          source: "replay_transition" as const,
          value: capture.replay_transitions[location.index],
        };
    }
  })();
  if (projected === null || projected.value === undefined) return null;
  const payload = jsonValueSchema.parse(projected.value);
  return {
    source: projected.source,
    captured_at_ms: atMilliseconds(payload),
    subject_id: subjectFor(projected.source, payload),
    payload,
  };
};

/** Project one validated capture-journal reference into the shared observation shape. */
export const projectProcessObservation = (
  capture: ProcessCapture,
  location: ProcessObservationLocation,
): ProcessObservation | null => {
  const projected = projectedRecord(capture, location);
  if (projected === null) return null;
  return createProcessObservation({
    source: projected.source,
    source_sequence: location.index,
    captured_at_ms: projected.captured_at_ms,
    subject_id: projected.subject_id,
    location,
    payload: projected.payload,
  });
};
