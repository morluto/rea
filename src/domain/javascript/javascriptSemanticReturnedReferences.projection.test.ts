import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsSteps } from "../../../tests/fixtures/javascriptSemanticIndex.js";
import { retainSemanticAmbientEffect } from "./javascriptSemanticAmbientWrites.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(
    source,
    "returned-reference-projection.js",
  );
  if (parsed === null) throw new Error("Expected valid fixture");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  return { parsed, state };
};

const callReads = (program: t.Program, name: string): t.Identifier[] => {
  const reads: t.Identifier[] = [];
  t.traverseFast(program, (node) => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name }))
      reads.push(node.callee);
  });
  return reads;
};

const callCallees = (program: t.Program, sourceName: string): t.Node[] => {
  const callees: t.Node[] = [];
  t.traverseFast(program, (node) => {
    if (!t.isCallExpression(node)) return;
    let root = node.callee;
    while (t.isMemberExpression(root)) root = root.object;
    if (t.isIdentifier(root, { name: sourceName })) callees.push(node.callee);
  });
  return callees;
};

const returnedExpression = (program: t.Program, name: string): t.Node => {
  let found: t.Node | undefined;
  t.traverseFast(program, (node) => {
    if (
      found === undefined &&
      t.isFunctionDeclaration(node) &&
      node.id?.name === name
    )
      t.traverseFast(node.body, (child) => {
        if (
          found === undefined &&
          t.isReturnStatement(child) &&
          child.argument !== null
        )
          found = child.argument;
      });
  });
  if (found === undefined)
    throw new Error(`Missing return expression in ${name}`);
  return found;
};

const resultIdentifier = (program: t.Program, name: string): t.Identifier => {
  let found: t.Identifier | undefined;
  t.traverseFast(program, (node) => {
    if (
      found === undefined &&
      ((t.isReturnStatement(node) && node.argument !== null) ||
        (t.isYieldExpression(node) && node.argument !== null))
    )
      t.traverseFast(node.argument, (child) => {
        if (found === undefined && t.isIdentifier(child, { name }))
          found = child;
      });
  });
  if (found === undefined) throw new Error(`Missing result expression ${name}`);
  return found;
};

it("keeps returned-reference targets at the source read position", () => {
  const { parsed, state } = indexed(`
    function beforeTarget() { return beforeResult; }
    function afterTarget() { return afterResult; }
    function choose() {
      let callback = beforeTarget;
      callback();
      callback = afterTarget;
      callback();
    }
  `);
  const [beforeRead, afterRead] = callReads(parsed.program, "callback");
  if (beforeRead === undefined || afterRead === undefined)
    throw new Error("Missing callback reads");
  const returnedReferences = createSemanticReturnedReferences(state);

  const before = returnedReferences(beforeRead);
  const after = returnedReferences(afterRead);

  expect(before.precision).toBe("exact");
  expect(before.references.map(({ node }) => node)).toEqual([
    returnedExpression(parsed.program, "beforeTarget"),
  ]);
  expect(after.precision).toBe("exact");
  expect(after.references.map(({ node }) => node)).toEqual([
    returnedExpression(parsed.program, "afterTarget"),
  ]);
});

it("resolves a finite object and array projection exactly", () => {
  const { parsed, state } = indexed(`
    function target() { return targetResult; }
    const box = { nested: [target] };
    const callback = box.nested[0];
    callback();
  `);
  const [read] = callReads(parsed.program, "callback");
  if (read === undefined) throw new Error("Missing callback read");

  const result = createSemanticReturnedReferences(state)(read);

  expect(result.precision).toBe("exact");
  expect(result.references.map(({ node }) => node)).toEqual([
    returnedExpression(parsed.program, "target"),
  ]);
});

it("reports conservative widening for a shrinking projection cycle", () => {
  const { parsed, state } = indexed(`
    function target() { return targetResult; }
    let cursor = { target };
    while (flag) cursor = { next: cursor, target };
    cursor.next.next.target();
  `);
  const [callee] = callCallees(parsed.program, "cursor");
  if (callee === undefined) throw new Error("Missing projected call");

  const result = createSemanticReturnedReferences(state)(callee);

  expect(result.precision).toBe("widened");
  expect(result.references.map(({ node }) => node)).toEqual([
    returnedExpression(parsed.program, "target"),
  ]);
});

it("widens a growing projection while retaining zero-depth and nested targets", () => {
  const { parsed, state } = indexed(`
    function zeroDepthTarget() { return zeroDepthResult; }
    function objectTarget() { return objectResult; }
    function arrayTarget() { return arrayResult; }
    function* generatorTarget() { yield* generatorResult; }
    const shape = {
      zero: zeroDepthTarget,
      nested: {
        object: objectTarget,
        array: [arrayTarget],
        class: class NestedTarget { method() { return classResult; } },
        generator: generatorTarget,
      },
    };
    let cursor = shape;
    function walk(flag) {
      while (flag) cursor = cursor.next;
      return cursor();
    }
    walk(true);
  `);
  const [read] = callReads(parsed.program, "cursor");
  if (read === undefined) throw new Error("Missing cursor read");

  const result = createSemanticReturnedReferences(state)(read);
  const expressions = result.references.map(({ node }) => node);

  expect(result.precision).toBe("widened");
  for (const name of ["zeroDepthTarget", "objectTarget", "arrayTarget"])
    expect(expressions).toContain(returnedExpression(parsed.program, name));
  expect(expressions).toContain(
    resultIdentifier(parsed.program, "classResult"),
  );
  const generatorResult = resultIdentifier(parsed.program, "generatorResult");
  expect(result.references).toContainEqual({
    node: generatorResult,
    projection: [null],
  });
});

it("widens a cycle that rewrites the path head while increasing its depth", () => {
  const { parsed, state } = indexed(`
    function target() { return targetResult; }
    let value = {};
    while (flag)
      value = {
        a: value.x.y,
        x: value.a.z,
        target,
      };
    value.a.b();
  `);
  const [callee] = callCallees(parsed.program, "value");
  if (callee === undefined) throw new Error("Missing projected call");

  const result = createSemanticReturnedReferences(state)(callee);

  expect(result.precision).toBe("widened");
  expect(result.references.map(({ node }) => node)).toContain(
    returnedExpression(parsed.program, "target"),
  );
});

it("retains both finite class-prototype callable selections", () => {
  const { parsed, state } = indexed(`
    class C { first(){return firstResult} second(){return secondResult} }
    const selected=flag?C.prototype.first:C.prototype.second;
    selected();
  `);
  const [read] = callReads(parsed.program, "selected");
  if (read === undefined)
    throw new Error("Missing selected prototype method call");
  const result = createSemanticReturnedReferences(state)(read);
  expect(result.precision).toBe("exact");
  expect(
    result.references
      .map(({ node }) => (t.isIdentifier(node) ? node.name : null))
      .sort(),
  ).toEqual(["firstResult", "secondResult"]);
});

it("does not traverse lexical aliases again as independent ambient writes accumulate", () => {
  const length = 48;
  const { parsed, state } = indexed(
    "function f0(){return output;}" +
      Array.from(
        { length },
        (_, index) => `const f${index + 1}=f${index};`,
      ).join("") +
      `f${length}();`,
  );
  const [read] = callReads(parsed.program, `f${length}`);
  if (read === undefined) throw new Error("Missing lexical call");
  const expected = returnedExpression(parsed.program, "f0");
  const returned = createSemanticReturnedReferences(state);
  const observed = returned(read);
  expect(observed.references).toEqual([{ node: expected, projection: [] }]);

  // Returning the retained result witnesses that no new alias walk ran.
  for (let index = 0; index < length; index++) {
    retainSemanticAmbientEffect(
      state,
      "write",
      ["global", `property${index}`],
      undefined,
    );
    expect(returned(read)).toBe(observed);
  }
});

it.each([
  ["const [callback=g]=[f];callback();", "callback", ["before"]],
  ["const callback=[...[f],g];callback[1]();", "callback", ["after"]],
] as const)(
  "revisits a live iterator proof after an ambient effect: %s",
  (source, name, first) => {
    const { parsed, state } = indexed(
      "function f(){return before;}function g(){return after;}" + source,
    );
    const [read] = callCallees(parsed.program, name);
    if (read === undefined) throw new Error("Missing iterator-dependent call");
    const returned = createSemanticReturnedReferences(state);
    const names = () =>
      returned(read)
        .references.map(({ node }) => (t.isIdentifier(node) ? node.name : null))
        .sort();
    expect(names()).toEqual(first);
    retainSemanticAmbientEffect(
      state,
      "write",
      ["array-iterator-prototype", "next"],
      undefined,
    );
    expect(names()).toEqual(["after", "before"]);
  },
);

it("classifies each binding's ambient dependencies once per returned walk", () => {
  const count = 48;
  const { parsed, state } = indexed(
    "function output(){return value;}" +
      "const callback=" +
      "flag ? output : ".repeat(count) +
      "output;callback();",
  );
  const [read] = callReads(parsed.program, "callback");
  const binding = [...state.bindingsById.values()].find(
    ({ name }) => name === "output",
  );
  const initializer = binding?.initializers[0];
  if (read === undefined || initializer === undefined)
    throw new Error("Expected callable and initializer");
  let dependencyChecks = 0;
  Object.defineProperty(initializer, "iterationSources", {
    get: () => {
      dependencyChecks += 1;
      return undefined;
    },
  });
  const result = createSemanticReturnedReferences(state)(read);
  expect(result.references).toEqual([
    { node: returnedExpression(parsed.program, "output"), projection: [] },
  ]);
  // Each source read still selects its initializer. The extra dependency
  // check describes the binding once, irrespective of the number of reads.
  expect(dependencyChecks).toBeGreaterThanOrEqual(count);
  expect(dependencyChecks).toBeLessThan(count + 8);
});
