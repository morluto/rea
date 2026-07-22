import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "./jsonValue.js";
import type { ProcessCapture } from "./processCapture.js";
import {
  canonicalTraceJson,
  processTraceCardinalityBounds,
  type ProcessTraceSource,
  type ProcessTraceSpecification,
} from "./processTraceSpecification.js";

const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);

export type ProcessTraceLocation = {
  readonly collection:
    | "frames"
    | "rendered_frames"
    | "interaction_events"
    | "lifecycle"
    | "process_samples"
    | "filesystem_checkpoints"
    | "shim_events"
    | "protocol_events"
    | "replay_transitions";
  readonly index: number;
  readonly capture_order: number;
};

const locationSchema = z.strictObject({
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

const matchedEventSchema = z.strictObject({
  event_id: identifierSchema,
  location: locationSchema,
});

const sideResultSchema = z.strictObject({
  status: z.enum(["pass", "fail", "unknown"]),
  matched_variant: identifierSchema.nullable(),
  satisfied_constraints: z.array(z.string()),
  raw_trace: z.array(matchedEventSchema),
});

const diagnosticSchema = z.strictObject({
  kind: z.enum([
    "journal",
    "predicate",
    "cardinality",
    "edge",
    "prefix",
    "suffix",
    "trace",
  ]),
  side: z.enum(["left", "right"]),
  message: z.string(),
  event_ids: z.array(identifierSchema),
  locations: z.array(locationSchema),
});

/** Structured verdict for one declared process trace language. */
export const processTraceComparisonResultSchema = z.strictObject({
  verdict: z.enum(["equivalent", "different", "unknown"]),
  left: sideResultSchema,
  right: sideResultSchema,
  diagnostic: diagnosticSchema.nullable(),
});
export type ProcessTraceComparisonResult = z.infer<
  typeof processTraceComparisonResultSchema
>;

type TraceRecord = {
  readonly source: ProcessTraceSource;
  readonly payload: JsonValue;
  readonly location: ProcessTraceLocation;
};

const recordAt = (
  capture: ProcessCapture,
  location: ProcessTraceLocation,
): Omit<TraceRecord, "location"> | null => {
  const value = (() => {
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
  if (value === null || value.value === undefined) return null;
  return { source: value.source, payload: jsonValueSchema.parse(value.value) };
};

const scopesFor = (
  sources: ReadonlySet<ProcessTraceSource>,
): ReadonlySet<string> =>
  new Set(
    [...sources].map((source) => {
      if (source.startsWith("terminal_")) return "terminal";
      if (source === "lifecycle") return "exit";
      if (
        source === "http" ||
        source === "websocket" ||
        source === "replay_transition"
      )
        return "protocol";
      if (source === "filesystem") return "filesystem";
      if (source === "process") return "process";
      if (source === "shim") return "shim";
      return "interaction";
    }),
  );

const unknownSide = (): z.infer<typeof sideResultSchema> => ({
  status: "unknown",
  matched_variant: null,
  satisfied_constraints: [],
  raw_trace: [],
});

export type EvaluatedSide = {
  readonly result: z.infer<typeof sideResultSchema>;
  readonly diagnostic: Omit<z.infer<typeof diagnosticSchema>, "side"> | null;
};

type FailureInput = {
  readonly kind: z.infer<typeof diagnosticSchema>["kind"];
  readonly message: string;
  readonly eventIds: readonly string[];
  readonly locations: readonly ProcessTraceLocation[];
  readonly rawTrace: z.infer<typeof matchedEventSchema>[];
};

const failure = (input: FailureInput): EvaluatedSide => ({
  result: {
    status: "fail",
    matched_variant: null,
    satisfied_constraints: [],
    raw_trace: input.rawTrace,
  },
  diagnostic: {
    kind: input.kind,
    message: input.message,
    event_ids: [...input.eventIds],
    locations: [...input.locations],
  },
});

const evaluateFiniteTrace = (
  ids: readonly string[],
  specification: ProcessTraceSpecification,
): string | null => {
  if (specification.language.kind !== "finite_traces") return null;
  for (const variant of specification.language.variants) {
    let offset = 0;
    let accepted = true;
    for (const token of variant.trace) {
      if (typeof token === "string") {
        if (ids[offset] !== token) accepted = false;
        offset += 1;
        continue;
      }
      const actual = ids.slice(offset, offset + token.unordered.length).sort();
      const expected = [...token.unordered].sort();
      if (canonicalTraceJson(actual) !== canonicalTraceJson(expected))
        accepted = false;
      offset += token.unordered.length;
    }
    if (accepted && offset === ids.length) return variant.id;
  }
  return null;
};

type MatchedTrace = {
  readonly rawTrace: z.infer<typeof matchedEventSchema>[];
  readonly locationsById: ReadonlyMap<string, ProcessTraceLocation[]>;
};

const collectRecords = (
  capture: ProcessCapture,
  sources: ReadonlySet<ProcessTraceSource>,
): readonly TraceRecord[] => {
  const records: TraceRecord[] = [];
  for (const location of capture.event_journal ?? []) {
    const record = recordAt(capture, location);
    if (record !== null && sources.has(record.source))
      records.push({ ...record, location });
  }
  return records;
};

const matchRecords = (
  records: readonly TraceRecord[],
  specification: ProcessTraceSpecification,
): MatchedTrace | EvaluatedSide => {
  const rawTrace: z.infer<typeof matchedEventSchema>[] = [];
  const locationsById = new Map<string, ProcessTraceLocation[]>();
  for (const record of records) {
    const matches = specification.events.filter(
      (event) =>
        event.source === record.source &&
        canonicalTraceJson(event.exact) === canonicalTraceJson(record.payload),
    );
    if (matches.length !== 1)
      return failure({
        kind: "predicate",
        message:
          matches.length === 0
            ? "Observed event does not match any declared exact predicate."
            : "Observed event matches multiple predicates.",
        eventIds: matches.map(({ id }) => id),
        locations: [record.location],
        rawTrace,
      });
    const match = matches[0];
    if (match === undefined)
      throw new TypeError("Unique trace match is missing");
    rawTrace.push({ event_id: match.id, location: record.location });
    const locations = locationsById.get(match.id) ?? [];
    locations.push(record.location);
    locationsById.set(match.id, locations);
  }
  return { rawTrace, locationsById };
};

const cardinalityFailure = (
  trace: MatchedTrace,
  specification: ProcessTraceSpecification,
): EvaluatedSide | null => {
  for (const event of specification.events) {
    const [minimum, maximum] = processTraceCardinalityBounds(event.cardinality);
    const locations = trace.locationsById.get(event.id) ?? [];
    if (locations.length < minimum || locations.length > maximum)
      return failure({
        kind: "cardinality",
        message: `${event.id} observed ${String(locations.length)} times; expected ${String(minimum)}..${String(maximum)}.`,
        eventIds: [event.id],
        locations,
        rawTrace: trace.rawTrace,
      });
  }
  return null;
};

const evaluatePartialOrder = (
  trace: MatchedTrace,
  specification: ProcessTraceSpecification,
): EvaluatedSide => {
  if (specification.language.kind !== "partial_order")
    throw new TypeError("Expected a partial-order trace specification");
  const satisfied: string[] = [];
  for (const edge of specification.language.happens_before) {
    const before = trace.locationsById.get(edge.before) ?? [];
    const after = trace.locationsById.get(edge.after) ?? [];
    const lastBefore = before.at(-1);
    const firstAfter = after[0];
    if (
      lastBefore !== undefined &&
      firstAfter !== undefined &&
      lastBefore.capture_order >= firstAfter.capture_order
    )
      return failure({
        kind: "edge",
        message: `${edge.before} must happen before ${edge.after}.`,
        eventIds: [edge.before, edge.after],
        locations: [lastBefore, firstAfter],
        rawTrace: trace.rawTrace,
      });
    satisfied.push(`happens_before:${edge.before}:${edge.after}`);
  }
  const ids = trace.rawTrace.map(({ event_id }) => event_id);
  const prefix = specification.language.prefix;
  if (
    canonicalTraceJson(ids.slice(0, prefix.length)) !==
    canonicalTraceJson(prefix)
  )
    return failure({
      kind: "prefix",
      message: "Observed trace does not satisfy the declared prefix.",
      eventIds: prefix,
      locations: trace.rawTrace
        .slice(0, prefix.length)
        .map(({ location }) => location),
      rawTrace: trace.rawTrace,
    });
  const suffix = specification.language.suffix;
  if (
    canonicalTraceJson(suffix.length === 0 ? [] : ids.slice(-suffix.length)) !==
    canonicalTraceJson(suffix)
  )
    return failure({
      kind: "suffix",
      message: "Observed trace does not satisfy the declared suffix.",
      eventIds: suffix,
      locations: trace.rawTrace
        .slice(-suffix.length)
        .map(({ location }) => location),
      rawTrace: trace.rawTrace,
    });
  satisfied.push(
    ...specification.language.unordered_groups.map(
      ({ events }) => `unordered:${events.join(":")}`,
    ),
  );
  if (prefix.length > 0) satisfied.push(`prefix:${prefix.join(":")}`);
  if (suffix.length > 0) satisfied.push(`suffix:${suffix.join(":")}`);
  return {
    result: {
      status: "pass",
      matched_variant: null,
      satisfied_constraints: satisfied,
      raw_trace: trace.rawTrace,
    },
    diagnostic: null,
  };
};

const evaluateMatchedTrace = (
  trace: MatchedTrace,
  specification: ProcessTraceSpecification,
): EvaluatedSide => {
  const invalidCardinality = cardinalityFailure(trace, specification);
  if (invalidCardinality !== null) return invalidCardinality;
  if (specification.language.kind === "partial_order")
    return evaluatePartialOrder(trace, specification);
  const ids = trace.rawTrace.map(({ event_id }) => event_id);
  const variant = evaluateFiniteTrace(ids, specification);
  return variant === null
    ? failure({
        kind: "trace",
        message: "Observed events do not match any finite trace variant.",
        eventIds: ids,
        locations: trace.rawTrace.map(({ location }) => location),
        rawTrace: trace.rawTrace,
      })
    : {
        result: {
          status: "pass",
          matched_variant: variant,
          satisfied_constraints: [`variant:${variant}`],
          raw_trace: trace.rawTrace,
        },
        diagnostic: null,
      };
};

export const evaluateProcessTraceSide = (
  capture: ProcessCapture,
  specification: ProcessTraceSpecification,
): EvaluatedSide => {
  const sources = new Set(specification.events.map(({ source }) => source));
  const relevantScopes = scopesFor(sources);
  if (
    capture.truncated ||
    capture.residual_unknowns.some(({ scope }) => relevantScopes.has(scope))
  )
    return { result: unknownSide(), diagnostic: null };
  if ((capture.event_journal ?? []).length === 0)
    return {
      result: unknownSide(),
      diagnostic: {
        kind: "journal",
        message: "Capture has no cross-source event journal.",
        event_ids: [],
        locations: [],
      },
    };
  const matched = matchRecords(collectRecords(capture, sources), specification);
  return "rawTrace" in matched
    ? evaluateMatchedTrace(matched, specification)
    : matched;
};
