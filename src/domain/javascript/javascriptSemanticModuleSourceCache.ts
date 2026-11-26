import type * as t from "@babel/types";
import { semanticConsumerMemo } from "./javascriptSemanticConsumer.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import type { JavaScriptSemanticResourceLimit } from "./javascriptSemanticValueTypes.js";

/** One completed module-source query and the resource limits it recorded. */
export interface CachedSemanticModuleSourceMatch<Match> {
  readonly match: Match;
  readonly limits: readonly JavaScriptSemanticResourceLimit[];
}

type QueriesByRead<Match> = Map<
  t.Node | undefined,
  Map<string, CachedSemanticModuleSourceMatch<Match>>
>;

const matchesByState =
  semanticConsumerMemo<WeakMap<t.Node, QueriesByRead<unknown>>>();

/**
 * Queries for one source node, keyed by read site and options. Callers use it
 * only after member-mutation facts are complete; every value-cache or
 * require-delegate invalidation clears it.
 */
export const semanticModuleSourceQueries = <Match>(
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
): QueriesByRead<Match> => {
  let byNode = matchesByState.get(state);
  if (byNode === undefined) {
    byNode = new WeakMap();
    matchesByState.set(state, byNode);
  }
  let queries = byNode.get(node);
  if (queries === undefined) {
    queries = new Map();
    byNode.set(node, queries);
  }
  return queries as QueriesByRead<Match>;
};

/** Forget every retained module-source query of one analysis state. */
export const clearSemanticModuleSourceQueries = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  matchesByState.delete(state);
};
