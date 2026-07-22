import { compareCodePoints } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptSemanticGraphNode } from "../domain/javascriptSemanticGraph.js";
import { JAVASCRIPT_SEMANTIC_RELATION_FAMILIES } from "../domain/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSemanticIr } from "../domain/javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";

/** Find the innermost callable that contains one exact source range. */
export const owningSemanticCallableNode = (
  location: JavaScriptSourceRange | null,
  ir: JavaScriptSemanticIr,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): JavaScriptSemanticGraphNode | undefined => {
  if (location === null) return undefined;
  return ir.callables
    .filter((callable) => contains(callable.location, location))
    .sort((left, right) =>
      compareCodePoints(
        positionKey(right.location),
        positionKey(left.location),
      ),
    )
    .map(({ callableId }) => nodes.get(callableId))
    .find((node) => node !== undefined);
};

/** Find retained semantic nodes whose exact ranges are within one expression. */
export const semanticNodesWithinRange = (
  nodes: readonly JavaScriptSemanticGraphNode[],
  range: JavaScriptSourceRange,
): JavaScriptSemanticGraphNode[] =>
  nodes.filter(
    (node) =>
      node.identity.source_range !== null &&
      contains(range, node.identity.source_range),
  );

/** Report extractor support without treating missing families as absence. */
export const semanticFamilyStatus = (
  family: (typeof JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)[number],
  analysis: JavaScriptArtifactAnalysis,
  truncated: boolean,
): "complete" | "partial" | "unknown" | "unsupported" => {
  if (!["call-flow", "closure", "data-flow", "object-flow"].includes(family))
    return "unsupported";
  if (truncated) return "unknown";
  return analysis.truncated_scopes === 0 ? "partial" : "unknown";
};

/** Compare two exact semantic source ranges. */
export const semanticRangesEqual = (
  left: JavaScriptSourceRange | null,
  right: JavaScriptSourceRange,
): boolean =>
  left !== null &&
  left.start.line === right.start.line &&
  left.start.column === right.start.column &&
  left.end.line === right.end.line &&
  left.end.column === right.end.column;

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
