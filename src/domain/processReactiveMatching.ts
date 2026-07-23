import canonicalize from "canonicalize";

import type { ProcessObservation } from "./processObservation.js";
import { comparableProcessObservationPayload } from "./processObservation.js";
import {
  PROCESS_REACTIVE_LIMITS,
  type ProcessReactiveFrontier,
  type ProcessReactiveTrigger,
} from "./processReactiveScenario.js";
import type { ProcessReactiveSnapshot } from "./processReactiveRuntime.js";

/** Internal bounded trigger-match result used by the pure reducer. */
export interface ProcessReactiveTriggerMatch {
  readonly matched: boolean;
  readonly eventIds: readonly string[];
  readonly consumeIds: readonly string[];
  readonly lastOrder: number;
  readonly overflow: boolean;
}

interface EvaluationBudget {
  remaining: number;
}

interface TriggerMatchContext {
  readonly snapshot: ProcessReactiveSnapshot;
  readonly budget: EvaluationBudget;
  readonly afterOrder: number;
  readonly upperOrder: number | null;
}

const spendEvaluationWork = (
  budget: EvaluationBudget,
  units: number,
): boolean => {
  if (units > budget.remaining) return false;
  budget.remaining -= units;
  return true;
};

const noMatch = (overflow = false): ProcessReactiveTriggerMatch => ({
  matched: false,
  eventIds: [],
  consumeIds: [],
  lastOrder: -1,
  overflow,
});

const frontierOrder = (
  frontier: ProcessReactiveFrontier,
  snapshot: ProcessReactiveSnapshot,
): number | null => {
  switch (frontier.kind) {
    case "scenario_start":
      return -1;
    case "state_entry":
      return snapshot.state_entry_capture_order - 1;
    case "checkpoint":
      return (
        snapshot.checkpoints.findLast(({ name }) => name === frontier.name)
          ?.capture_order ?? null
      );
    case "event_id":
      return (
        snapshot.observations.find(
          ({ event_id }) => event_id === frontier.event_id,
        )?.capture_order ?? null
      );
  }
};

const eligibleObservations = (
  frontier: ProcessReactiveFrontier,
  context: TriggerMatchContext,
): readonly ProcessObservation[] => {
  const frontierValue = frontierOrder(frontier, context.snapshot);
  if (frontierValue === null) return [];
  const lowerBound = Math.max(frontierValue, context.afterOrder);
  const consumed = new Set(context.snapshot.consumed_event_ids);
  return context.snapshot.observations.filter(
    ({ capture_order, event_id }) =>
      capture_order > lowerBound &&
      (context.upperOrder === null || capture_order <= context.upperOrder) &&
      !consumed.has(event_id),
  );
};

const canonicalJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Reactive scenario value is not canonical JSON");
  return serialized;
};

const matchEvent = (
  trigger: Extract<ProcessReactiveTrigger, { readonly kind: "event" }>,
  context: TriggerMatchContext,
): ProcessReactiveTriggerMatch => {
  const expected = canonicalJson(
    comparableProcessObservationPayload(trigger.exact, trigger.ignore_fields),
  );
  const matches: ProcessObservation[] = [];
  for (const observation of eligibleObservations(trigger.since, context)) {
    if (!spendEvaluationWork(context.budget, 1)) return noMatch(true);
    if (
      observation.source === trigger.source &&
      canonicalJson(
        comparableProcessObservationPayload(
          observation.payload,
          trigger.ignore_fields,
        ),
      ) === expected
    )
      matches.push(observation);
  }
  if (
    matches.length < trigger.cardinality.min ||
    matches.length > trigger.cardinality.max
  )
    return noMatch();
  const eventIds = matches.map(({ event_id }) => event_id);
  return {
    matched: true,
    eventIds,
    consumeIds: trigger.consume ? eventIds : [],
    lastOrder: matches.at(-1)?.capture_order ?? context.afterOrder,
    overflow: false,
  };
};

const occurrenceRange = (
  haystack: string,
  needle: string,
  occurrence: number,
): { readonly start: number; readonly end: number } | null => {
  let offset = 0;
  let start = -1;
  for (let found = 0; found < occurrence; found += 1) {
    start = haystack.indexOf(needle, offset);
    if (start < 0) return null;
    offset = start + needle.length;
  }
  return { start, end: offset };
};

const matchTerminalText = (
  trigger: Extract<ProcessReactiveTrigger, { readonly kind: "terminal_text" }>,
  context: TriggerMatchContext,
): ProcessReactiveTriggerMatch => {
  const chunks: { observation: ProcessObservation; text: string }[] = [];
  for (const observation of eligibleObservations(trigger.since, context)) {
    if (!spendEvaluationWork(context.budget, 1)) return noMatch(true);
    if (
      observation.source === "terminal_raw" &&
      typeof observation.payload === "object" &&
      observation.payload !== null &&
      !Array.isArray(observation.payload) &&
      typeof observation.payload["data"] === "string"
    )
      chunks.push({ observation, text: observation.payload["data"] });
  }
  let rawBytes = 0;
  for (const { text } of chunks) {
    if (text.length > PROCESS_REACTIVE_LIMITS.terminalMatchBytes)
      return noMatch(true);
    const bytes = Buffer.byteLength(text);
    rawBytes += bytes;
    if (
      rawBytes > PROCESS_REACTIVE_LIMITS.terminalMatchBytes ||
      !spendEvaluationWork(context.budget, bytes)
    )
      return noMatch(true);
  }
  const range = occurrenceRange(
    chunks.map(({ text }) => text).join(""),
    trigger.literal,
    trigger.occurrence,
  );
  if (range === null) return noMatch();
  let firstChunk = 0;
  let lastChunk = 0;
  let characters = 0;
  for (const [index, chunk] of chunks.entries()) {
    characters += chunk.text.length;
    if (characters <= range.start) firstChunk = index + 1;
    if (characters >= range.end) {
      lastChunk = index;
      break;
    }
  }
  const matched = chunks
    .slice(firstChunk, lastChunk + 1)
    .map(({ observation }) => observation);
  const eventIds = matched.map(({ event_id }) => event_id);
  return {
    matched: true,
    eventIds,
    consumeIds: trigger.consume ? eventIds : [],
    lastOrder: matched.at(-1)?.capture_order ?? context.afterOrder,
    overflow: false,
  };
};

const mergeMatches = (
  matches: readonly ProcessReactiveTriggerMatch[],
): ProcessReactiveTriggerMatch => ({
  matched: matches.every(({ matched }) => matched),
  eventIds: [...new Set(matches.flatMap(({ eventIds }) => eventIds))],
  consumeIds: [...new Set(matches.flatMap(({ consumeIds }) => consumeIds))],
  lastOrder: Math.max(-1, ...matches.map(({ lastOrder }) => lastOrder)),
  overflow: matches.some(({ overflow }) => overflow),
});

const matchEarliestPrefix = (
  trigger: ProcessReactiveTrigger,
  context: TriggerMatchContext,
): ProcessReactiveTriggerMatch => {
  for (const observation of context.snapshot.observations) {
    if (observation.capture_order <= context.afterOrder) continue;
    if (
      context.upperOrder !== null &&
      observation.capture_order > context.upperOrder
    )
      break;
    const matched = matchTrigger(trigger, {
      ...context,
      upperOrder: observation.capture_order,
    });
    if (matched.matched || matched.overflow) return matched;
  }
  return noMatch();
};

const matchTrigger = (
  trigger: ProcessReactiveTrigger,
  context: TriggerMatchContext,
): ProcessReactiveTriggerMatch => {
  if (trigger.kind === "event") return matchEvent(trigger, context);
  if (trigger.kind === "terminal_text")
    return matchTerminalText(trigger, context);
  if (trigger.kind === "all")
    return mergeMatches(
      trigger.triggers.map((child) => matchTrigger(child, context)),
    );
  if (trigger.kind === "any") {
    const evaluated = trigger.triggers.map((child) =>
      matchTrigger(child, context),
    );
    const matches = evaluated.filter(({ matched }) => matched);
    return matches.length === 0
      ? noMatch(evaluated.some(({ overflow }) => overflow))
      : mergeMatches(matches);
  }
  if (trigger.kind === "sequence") {
    const matches: ProcessReactiveTriggerMatch[] = [];
    let cursor = context.afterOrder;
    for (const child of trigger.triggers) {
      const matched = matchEarliestPrefix(child, {
        ...context,
        afterOrder: cursor,
      });
      if (!matched.matched) return noMatch(matched.overflow);
      matches.push(matched);
      cursor = matched.lastOrder;
    }
    return mergeMatches(matches);
  }
  const matches: ProcessReactiveTriggerMatch[] = [];
  let cursor = context.afterOrder;
  while (matches.length < trigger.max) {
    const matched = matchEarliestPrefix(trigger.trigger, {
      ...context,
      afterOrder: cursor,
    });
    if (!matched.matched || matched.lastOrder <= cursor) break;
    matches.push(matched);
    cursor = matched.lastOrder;
  }
  if (matches.length === trigger.max) {
    const excess = matchEarliestPrefix(trigger.trigger, {
      ...context,
      afterOrder: cursor,
    });
    if (excess.matched || excess.overflow) return noMatch(excess.overflow);
  }
  if (matches.length < trigger.min)
    return noMatch(matches.some(({ overflow }) => overflow));
  return mergeMatches(matches);
};

/** Match one trigger using a shared deterministic work budget. */
export const matchProcessReactiveTrigger = (
  trigger: ProcessReactiveTrigger,
  snapshot: ProcessReactiveSnapshot,
  budget: EvaluationBudget,
): ProcessReactiveTriggerMatch =>
  matchTrigger(trigger, {
    snapshot,
    budget,
    afterOrder: -1,
    upperOrder: null,
  });
