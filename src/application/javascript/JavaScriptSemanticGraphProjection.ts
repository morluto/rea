import { compareCodePoints } from "../../domain/canonicalOrdering.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraph.js";
import { JAVASCRIPT_SEMANTIC_RELATION_FAMILIES } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";

interface SourceInterval {
  readonly range: JavaScriptSourceRange;
  readonly order: number;
}

interface CallableInterval extends SourceInterval {
  readonly callableId: string;
  readonly priority: string;
}

interface SourceIntervalTree<Interval extends SourceInterval> {
  readonly entry: Interval;
  readonly minimumStart: JavaScriptSourceRange["start"];
  readonly maximumStart: JavaScriptSourceRange["start"];
  readonly minimumEnd: JavaScriptSourceRange["end"];
  readonly maximumEnd: JavaScriptSourceRange["end"];
  readonly left: SourceIntervalTree<Interval> | null;
  readonly right: SourceIntervalTree<Interval> | null;
}

/** Index one immutable file IR; read retained callable membership at query time. */
export const createSemanticCallableOwnerLookup = (
  ir: JavaScriptSemanticIr,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): ((
  location: JavaScriptSourceRange | null,
) => JavaScriptSemanticGraphNode | undefined) => {
  const entries = ir.callables
    .map((callable, order): CallableInterval => ({
      callableId: callable.callableId,
      range: callable.location,
      order,
      priority: positionKey(callable.location),
    }))
    .sort(
      (left, right) =>
        pointCompare(left.range.start, right.range.start) ||
        left.order - right.order,
    );
  const tree = buildSourceIntervalTree(entries, 0, entries.length);
  return (location) => {
    if (location === null || tree === null || nodes.size === 0)
      return undefined;
    const pending = [tree];
    let best: CallableInterval | undefined;
    let result: JavaScriptSemanticGraphNode | undefined;
    while (pending.length > 0) {
      const current = pending.pop();
      if (
        current === undefined ||
        pointCompare(current.minimumStart, location.start) > 0 ||
        pointCompare(current.maximumEnd, location.end) < 0
      )
        continue;
      const candidate = current.entry;
      if (contains(candidate.range, location)) {
        const node = nodes.get(candidate.callableId);
        const rank =
          best === undefined
            ? 1
            : compareCodePoints(candidate.priority, best.priority) ||
              best.order - candidate.order;
        if (node !== undefined && rank > 0) {
          best = candidate;
          result = node;
        }
      }
      if (current.left !== null) pending.push(current.left);
      if (current.right !== null) pending.push(current.right);
    }
    return result;
  };
};

const buildSourceIntervalTree = <Interval extends SourceInterval>(
  entries: readonly Interval[],
  start: number,
  end: number,
): SourceIntervalTree<Interval> | null => {
  if (start >= end) return null;
  const middle = Math.floor((start + end) / 2);
  const entry = entries[middle];
  if (entry === undefined) return null;
  // This recursion follows a balanced index, not the producer's nesting depth.
  const left = buildSourceIntervalTree(entries, start, middle);
  const right = buildSourceIntervalTree(entries, middle + 1, end);
  let minimumEnd = entry.range.end;
  let maximumEnd = entry.range.end;
  for (const child of [left, right]) {
    if (child !== null && pointCompare(child.minimumEnd, minimumEnd) < 0)
      minimumEnd = child.minimumEnd;
    if (child !== null && pointCompare(child.maximumEnd, maximumEnd) > 0)
      maximumEnd = child.maximumEnd;
  }
  return {
    entry,
    minimumStart: left?.minimumStart ?? entry.range.start,
    maximumStart: right?.maximumStart ?? entry.range.start,
    minimumEnd,
    maximumEnd,
    left,
    right,
  };
};

/** Index an immutable node list; return contained ranges in producer order. */
export const createSemanticNodeRangeLookup = (
  nodes: readonly JavaScriptSemanticGraphNode[],
): ((range: JavaScriptSourceRange) => JavaScriptSemanticGraphNode[]) => {
  const entries = nodes
    .flatMap((node, order) => {
      const range = node.identity.source_range;
      return range === null ? [] : [{ node, range, order }];
    })
    .sort(
      (left, right) =>
        pointCompare(left.range.start, right.range.start) ||
        left.order - right.order,
    );
  const tree = buildSourceIntervalTree(entries, 0, entries.length);
  return (range) => {
    if (tree === null) return [];
    const pending = [tree];
    const matches: (typeof entries)[number][] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (
        current === undefined ||
        pointCompare(current.maximumStart, range.start) < 0 ||
        pointCompare(current.minimumEnd, range.end) > 0
      )
        continue;
      if (contains(range, current.entry.range)) matches.push(current.entry);
      if (current.left !== null) pending.push(current.left);
      if (current.right !== null) pending.push(current.right);
    }
    return matches
      .sort((left, right) => left.order - right.order)
      .map(({ node }) => node);
  };
};

/** Index exact call ranges, preserving the first producer occurrence. */
export const createSemanticCallSiteLookup = (
  ir: JavaScriptSemanticIr,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): ((
  range: JavaScriptSourceRange,
) => JavaScriptSemanticGraphNode | undefined) => {
  const identifiers = new Map<string, string>();
  for (const call of ir.callSites) {
    const key = rangeKey(call.location);
    if (!identifiers.has(key)) identifiers.set(key, call.callSiteId);
  }
  return (range) => {
    const identifier = identifiers.get(rangeKey(range));
    return identifier === undefined ? undefined : nodes.get(identifier);
  };
};

const rangeKey = (range: JavaScriptSourceRange): string =>
  `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`;

/** Report extractor support without treating missing families as absence. */
export const semanticFamilyStatus = (
  family: (typeof JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)[number],
  analysis: Pick<JavaScriptArtifactAnalysis, "truncated_scopes">,
): "complete" | "partial" | "unknown" | "unsupported" => {
  if (
    ![
      "call-flow",
      "boundary",
      "child-process",
      "closure",
      "configuration",
      "data-flow",
      "event",
      "object-flow",
      "promise-ownership",
      "request",
      "resource-lifecycle",
      "timer",
    ].includes(family)
  )
    return "unsupported";
  return analysis.truncated_scopes === 0 ? "partial" : "unknown";
};

const contains = (
  outer: JavaScriptSourceRange,
  inner: JavaScriptSourceRange,
): boolean =>
  pointCompare(outer.start, inner.start) <= 0 &&
  pointCompare(outer.end, inner.end) >= 0;

const pointCompare = (
  left: JavaScriptSourceRange["start"],
  right: JavaScriptSourceRange["start"],
): number => left.line - right.line || left.column - right.column;

const positionKey = (range: JavaScriptSourceRange): string =>
  `${String(range.start.line).padStart(12, "0")}:${String(range.start.column).padStart(12, "0")}`;
