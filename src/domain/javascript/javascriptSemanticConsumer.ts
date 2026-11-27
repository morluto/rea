import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticObservations,
} from "./javascriptSemanticState.js";

/**
 * One lexical index, several consumers.
 *
 * A {@link JavaScriptSemanticAnalysisState} holds three kinds of data with
 * different owners:
 *
 * - Index facts (scopes, bindings, retained effects) are derived from the
 *   program by the index steps and are shared by every consumer.
 * - Query memos are results a consumer derived from those facts. A memo may
 *   have recorded an observation only when it was computed, so one consumer
 *   reading another's memo would miss that observation.
 * - Observations (bounds reached, projections widened) describe what one
 *   derivation encountered and qualify only that derivation's results.
 *
 * Index steps record into the index's own observations. Each consumer starts
 * from those and from no memos, so its results equal the ones a private index
 * would have produced.
 */
const consumerMemos: WeakMap<JavaScriptSemanticAnalysisState, unknown>[] = [];

/**
 * Declare a per-state memo of query results. Every memo keyed by the state
 * is declared here, so a new consumer or index step starts without it. Index
 * facts are not memos and must not be declared through this owner.
 */
export const semanticConsumerMemo = <Value>(): WeakMap<
  JavaScriptSemanticAnalysisState,
  Value
> => {
  const memo = new WeakMap<JavaScriptSemanticAnalysisState, Value>();
  consumerMemos.push(memo);
  return memo;
};

const resetSemanticConsumerMemos = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  for (const memo of consumerMemos) memo.delete(state);
};

/** An empty observation log, or a copy that continues from `seed`. */
export const createSemanticObservations = (
  seed?: JavaScriptSemanticObservations,
): JavaScriptSemanticObservations => ({
  valueResourceLimits: new Set(seed?.valueResourceLimits),
  getterResourceLimits: new Set(seed?.getterResourceLimits),
  returnedReferenceWidenings: new Set(seed?.returnedReferenceWidenings),
});

const isIndexStepActive = (state: JavaScriptSemanticAnalysisState): boolean =>
  state.observations === state.indexObservations;

/**
 * Run one index step. The step reads no consumer memo and records into the
 * index's observations, so the facts and observations it produces do not
 * depend on which consumer requested it or on what that consumer queried
 * first. The requesting consumer then also holds the step's observations. A
 * step requested by another step joins it.
 */
export function* semanticIndexStep<Value>(
  state: JavaScriptSemanticAnalysisState,
  steps: Generator<void, Value>,
): Generator<void, Value> {
  if (isIndexStepActive(state)) return yield* steps;
  const consumer = state.observations;
  resetSemanticConsumerMemos(state);
  state.observations = state.indexObservations;
  try {
    return yield* steps;
  } finally {
    state.observations = consumer;
    const index = state.indexObservations;
    for (const limit of index.valueResourceLimits)
      consumer.valueResourceLimits.add(limit);
    for (const limit of index.getterResourceLimits)
      consumer.getterResourceLimits.add(limit);
    for (const site of index.returnedReferenceWidenings)
      consumer.returnedReferenceWidenings.add(site);
  }
}

/**
 * Start a new consumer of an index another consumer has read. It holds the
 * index's observations and none of the earlier consumer's memos or
 * observations.
 */
export const beginSemanticConsumer = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (isIndexStepActive(state))
    throw new TypeError(
      "A semantic consumer cannot start during a lexical index step",
    );
  resetSemanticConsumerMemos(state);
  state.observations = createSemanticObservations(state.indexObservations);
};
