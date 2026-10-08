import { expect, it } from "vitest";

import { compareCodePoints } from "../../domain/canonicalOrdering.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import {
  constructSemanticGraphNode,
  createSemanticGraphProjectionState,
} from "./JavaScriptSemanticGraphConstruction.js";
import {
  createSemanticCallableOwnerLookup,
  createSemanticNodeRangeLookup,
  createSemanticCallSiteLookup,
} from "./JavaScriptSemanticGraphProjection.js";
import { sourceRangesEqual } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";

const fixtureFile: JavaScriptArtifactFile = {
  path: "app.js",
  container_sha256: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: 0,
  inventory_artifact_id: "fixture-app",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: "" },
};

const nodesFor = (ir: JavaScriptSemanticIr) => {
  const state = createSemanticGraphProjectionState({ nodes: [] });

  return new Map(
    ir.callables.map((callable) => [
      callable.callableId,
      constructSemanticGraphNode(
        fixtureFile,
        {
          kind: "function",
          roleKey: callable.callableId,
          label: callable.name,
          location: callable.location,
          functionNodeId: null,
        },
        state,
      ),
    ]),
  );
};

// Reference behavior before the optimization, including stable ties and
// fallback when the most deeply nested callable has no retained graph node.
const previousOwner = (
  location: JavaScriptSourceRange | null,
  ir: JavaScriptSemanticIr,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
) => {
  if (location === null) return undefined;
  const compare = (
    left: JavaScriptSourceRange["start"],
    right: JavaScriptSourceRange["start"],
  ) => left.line - right.line || left.column - right.column;
  const key = (range: JavaScriptSourceRange) =>
    `${String(range.start.line).padStart(12, "0")}:${String(range.start.column).padStart(12, "0")}`;
  return ir.callables
    .filter(
      (callable) =>
        compare(callable.location.start, location.start) <= 0 &&
        compare(callable.location.end, location.end) >= 0,
    )
    .sort((left, right) =>
      compareCodePoints(key(right.location), key(left.location)),
    )
    .map((callable) => nodes.get(callable.callableId))
    .find((node) => node !== undefined);
};

const rangesFor = (ir: JavaScriptSemanticIr) => [
  null,
  ...ir.callables.map((callable) => callable.location),
  ...ir.bindings.flatMap((binding) =>
    binding.definitions.map((definition) => definition.location),
  ),
  ...ir.references.map((reference) => reference.location),
  { start: { line: 999, column: 0 }, end: { line: 999, column: 1 } },
];

it("matches the prior owner selection across nested functions, arrows and methods", () => {
  const ir = analyzeJavaScriptSemantics(`
    const outside = 1;
    function outer(parameter) {
      function inner(value) { return value + parameter; }
      const callback = argument => inner(argument);
      return callback(outside);
    }
    class Example { method(value) { return () => outer(value); } }
  `);
  const nodes = nodesFor(ir);
  const lookup = createSemanticCallableOwnerLookup(ir, nodes);
  for (const range of rangesFor(ir))
    expect(lookup(range)).toBe(previousOwner(range, ir, nodes));
});

it("reads retained node membership at query time and keeps file indexes independent", () => {
  const ir = analyzeJavaScriptSemantics(
    "function outer() { function inner() { return 1; } return inner(); }",
  );
  const inner = ir.callables.find((callable) => callable.name === "inner");
  if (inner === undefined) throw new Error("Missing inner fixture callable");
  const nodes = nodesFor(ir);
  const otherNodes = nodesFor(ir);
  const lookup = createSemanticCallableOwnerLookup(ir, nodes);
  const otherLookup = createSemanticCallableOwnerLookup(ir, otherNodes);
  const before = lookup(inner.location);
  expect(before?.label).toBe("inner");
  nodes.delete(inner.callableId);
  expect(lookup(inner.location)?.label).toBe("outer");
  expect(otherLookup(inner.location)?.label).toBe("inner");
  if (before === undefined) throw new Error("Missing retained fixture node");
  nodes.set(inner.callableId, before);
  expect(lookup(inner.location)).toBe(before);
});

it("preserves stable ties and non-nested overlapping ranges", () => {
  const original = analyzeJavaScriptSemantics(
    "function first() { return 1; } function second() { return 2; } function third() { return 3; }",
  );
  const range = (start: number, end: number): JavaScriptSourceRange => ({
    start: { line: 1, column: start },
    end: { line: 1, column: end },
  });
  const ir = {
    ...original,
    callables: original.callables.map((callable, index) => ({
      ...callable,
      location: index === 0 ? range(0, 90) : range(20, index === 1 ? 60 : 80),
    })),
  };
  const nodes = nodesFor(ir);
  const lookup = createSemanticCallableOwnerLookup(ir, nodes);
  for (const query of [
    range(25, 30),
    range(25, 70),
    range(0, 80),
    range(80, 90),
    range(91, 92),
  ])
    expect(lookup(query)).toBe(previousOwner(query, ir, nodes));
});

it("matches the prior result across a compiled-style collection of sibling callables", () => {
  const ir = analyzeJavaScriptSemantics(
    Array.from(
      { length: 300 },
      (_, index) =>
        `function f${String(index)}(value) { return value + ${String(index)}; }`,
    ).join(""),
  );
  const nodes = nodesFor(ir);
  const lookup = createSemanticCallableOwnerLookup(ir, nodes);
  for (const range of rangesFor(ir))
    expect(lookup(range)).toBe(previousOwner(range, ir, nodes));
});

it("returns contained nodes in original order, including repeated and overlapping entries", () => {
  const ir = analyzeJavaScriptSemantics(`
    function outer(value) { function inner() { return value; } return inner(); }
    const sibling = () => outer(1);
  `);
  const nodes = [...nodesFor(ir).values()].reverse();
  const repeated = nodes[0];
  if (repeated === undefined) throw new Error("Missing range fixture node");
  nodes.push(
    repeated,
    constructSemanticGraphNode(
      fixtureFile,
      {
        kind: "module",
        roleKey: "module",
        location: null,
        label: "module",
        functionNodeId: null,
      },
      createSemanticGraphProjectionState({ nodes: [] }),
    ),
  );
  const lookup = createSemanticNodeRangeLookup(nodes);
  const compare = (
    left: JavaScriptSourceRange["start"],
    right: JavaScriptSourceRange["start"],
  ) => left.line - right.line || left.column - right.column;
  for (const range of rangesFor(ir)) {
    if (range === null) continue;
    const expected = nodes.filter(
      ({ identity }) =>
        identity.source_range !== null &&
        compare(range.start, identity.source_range.start) <= 0 &&
        compare(range.end, identity.source_range.end) >= 0,
    );
    expect(lookup(range)).toEqual(expected);
  }
  expect(
    createSemanticNodeRangeLookup([])(
      repeated.identity.source_range ?? {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 1 },
      },
    ),
  ).toEqual([]);
});

it("keeps first-call matching and current retained membership for exact locations", () => {
  const original = analyzeJavaScriptSemantics(
    "function target(value) { return value; } target(1); target(2);",
  );
  const first = original.callSites[0];
  const node = [...nodesFor(original).values()][0];
  if (first === undefined || node === undefined)
    throw new Error("Missing call fixture");
  const duplicate = { ...first, callSiteId: `${first.callSiteId}:duplicate` };
  const ir = {
    ...original,
    callSites: [first, duplicate, ...original.callSites.slice(1)],
  };
  const nodes = new Map(
    ir.callSites.map((call) => [
      call.callSiteId,
      constructSemanticGraphNode(
        fixtureFile,
        {
          kind: "call-site",
          roleKey: call.callSiteId,
          location: call.location,
          label: call.callSiteId,
          functionNodeId: null,
        },
        createSemanticGraphProjectionState({ nodes: [] }),
      ),
    ]),
  );
  const lookup = createSemanticCallSiteLookup(ir, nodes);
  const previous = (range: JavaScriptSourceRange) => {
    const call = ir.callSites.find((candidate) =>
      sourceRangesEqual(candidate.location, range),
    );
    return call === undefined ? undefined : nodes.get(call.callSiteId);
  };
  for (const call of ir.callSites)
    expect(lookup(call.location)).toBe(previous(call.location));
  nodes.delete(first.callSiteId);
  expect(lookup(first.location)).toBeUndefined();
  expect(nodes.has(duplicate.callSiteId)).toBe(true);
  nodes.set(first.callSiteId, node);
  expect(lookup(first.location)).toBe(node);
  expect(
    lookup({ start: { line: 99, column: 0 }, end: { line: 99, column: 1 } }),
  ).toBeUndefined();
});
