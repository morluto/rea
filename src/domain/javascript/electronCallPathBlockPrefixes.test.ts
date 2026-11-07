import * as t from "@babel/types";
import { expect, it } from "vitest";
import { ElectronCallPathBlockPrefixes } from "./electronCallPathBlockPrefixes.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

it("indexes a real flat block once, retaining contextual guards in source order", () => {
  const parsed = parseJavaScriptSource(`{
    ${"0;".repeat(2048)}
    if (uncertain) ordinary();
    if (flag) throw 0;
    electron.send("tail");
  }`);
  const block = parsed?.program.body[0];
  if (!t.isBlockStatement(block)) throw new Error("Expected parsed block");
  const first = block.body[0];
  const tail = block.body.at(-1);
  if (first === undefined || tail === undefined)
    throw new Error("Expected block statements");
  let examined = 0;
  const prefixes = new ElectronCallPathBlockPrefixes(() => {
    examined += 1;
    return true;
  });
  const steps = prefixes.before(block, tail);
  expect(steps.next()).toEqual({ done: false, value: undefined });
  expect(examined).toBe(2048);
  const prefix = completeSemanticSteps(steps);
  const completeVisits = examined;
  expect(completeVisits).toBeGreaterThan(block.body.length);
  expect(prefix).toMatchObject({
    before: 2050,
    entries: [
      {
        position: 2048,
        fact: {
          kind: "branch",
          test: { type: "Identifier", name: "uncertain" },
          consequentExits: false,
          alternateExits: false,
        },
      },
      {
        position: 2049,
        fact: {
          kind: "branch",
          test: { type: "Identifier", name: "flag" },
          consequentExits: true,
          alternateExits: false,
        },
      },
    ],
  });
  for (const statement of block.body) {
    const earlier = completeSemanticSteps(prefixes.before(block, statement));
    expect(earlier?.entries).toBe(prefix?.entries);
  }
  expect(examined).toBe(completeVisits);
  expect(completeSemanticSteps(prefixes.before(block, first))?.before).toBe(0);
});

it("does not publish an incomplete block index when its work budget ends", () => {
  const parsed = parseJavaScriptSource(
    `{ 0; 1; if (stop) throw 0; send("tail"); }`,
  );
  const block = parsed?.program.body[0];
  if (!t.isBlockStatement(block)) throw new Error("Expected parsed block");
  const tail = block.body.at(-1);
  if (tail === undefined) throw new Error("Expected terminal statement");
  let remaining = 2;
  const prefixes = new ElectronCallPathBlockPrefixes(() => --remaining >= 0);
  expect(completeSemanticSteps(prefixes.before(block, tail))).toBeUndefined();
  remaining = 100;
  expect(completeSemanticSteps(prefixes.before(block, tail))).toMatchObject({
    before: 3,
    entries: [{ position: 2, fact: { kind: "branch" } }],
  });
  expect(remaining).toBeGreaterThan(0);
});

it("charges nested exit checks to the same budget and does not cache a partial index", () => {
  const parsed = parseJavaScriptSource(
    `{ if (x) { { { throw 0; } } } send(); }`,
  );
  const block = parsed?.program.body[0];
  if (!t.isBlockStatement(block)) throw new Error("Expected parsed block");
  const tail = block.body.at(-1);
  if (tail === undefined) throw new Error("Expected terminal statement");
  let remaining = 4;
  const prefixes = new ElectronCallPathBlockPrefixes(() => --remaining >= 0);
  expect(completeSemanticSteps(prefixes.before(block, tail))).toBeUndefined();
  remaining = 100;
  expect(completeSemanticSteps(prefixes.before(block, tail))).toMatchObject({
    entries: [{ fact: { kind: "branch", consequentExits: true } }],
  });
});

it("retains labelled-jump and budget semantics when scanning loop children", () => {
  const parsed = parseJavaScriptSource(`guard: {
    if (outer) {
      while (again) { if (leave) break guard; }
      throw 0;
    }
    if (inner) {
      while (again) { local: { if (leave) break local; } }
      throw 0;
    }
    send("tail");
  }`);
  if (!parsed) throw new Error("Expected parsed program");
  const label = parsed.program.body[0];
  if (!t.isLabeledStatement(label) || !t.isBlockStatement(label.body))
    throw new Error("Expected labelled block");
  const block = label.body;
  const tail = block.body.at(-1);
  if (!tail) throw new Error("Expected terminal statement");
  const parents = new WeakMap<t.Node, t.Node>();
  traverseJavaScriptAst(parsed.program, {
    enter(node, parent) {
      if (parent) parents.set(node, parent);
    },
  });

  let visits = 0;
  const complete = new ElectronCallPathBlockPrefixes(() => {
    visits += 1;
    return true;
  }, parents);
  const result = completeSemanticSteps(complete.before(block, tail));
  expect(result).toMatchObject({
    before: 2,
    entries: [
      { position: 0, fact: { kind: "branch", consequentExits: true } },
      { position: 1, fact: { kind: "branch", consequentExits: true } },
    ],
  });
  const noParents = new ElectronCallPathBlockPrefixes(() => true);
  const unknownLabels = completeSemanticSteps(noParents.before(block, tail));
  expect(unknownLabels).toMatchObject({
    entries: [
      { fact: { kind: "branch", consequentExits: false } },
      { fact: { kind: "branch", consequentExits: false } },
    ],
  });
  // This count is characterized on the unchanged base: changing child
  // ordering or budget charging must not silently shift the threshold.
  expect(visits).toBe(35);
  const requiredVisits = 35;
  let remaining = requiredVisits - 1;
  const limited = new ElectronCallPathBlockPrefixes(
    () => --remaining >= 0,
    parents,
  );
  expect(completeSemanticSteps(limited.before(block, tail))).toBeUndefined();
  remaining = requiredVisits;
  expect(completeSemanticSteps(limited.before(block, tail))).toEqual(result);
  expect(remaining).toBeGreaterThanOrEqual(0);
});

it.each([
  [126, true],
  [127, false],
])(
  "retains the conservative loop-child depth boundary at %i wrappers",
  (wrappers, exits) => {
    let expression: t.Expression = t.identifier("condition");
    for (let index = 0; index < wrappers; index += 1)
      expression = t.unaryExpression("!", expression);
    const branch = t.ifStatement(
      t.identifier("selected"),
      t.blockStatement([
        t.whileStatement(expression, t.blockStatement([])),
        t.throwStatement(t.numericLiteral(0)),
      ]),
    );
    const block = t.blockStatement([branch]);
    const prefixes = new ElectronCallPathBlockPrefixes(() => true);
    expect(prefixes.statement(branch, block)).toMatchObject({
      kind: "branch",
      consequentExits: exits,
    });
  },
);

it("does not charge or enter nested function and class bodies during loop scans", () => {
  const inspect = (size: number) => {
    const parsed = parseJavaScriptSource(`{
      if (selected) {
        while (again) {
          function nested() { ${"0;".repeat(size)} }
          class Nested { method() { ${"0;".repeat(size)} } }
        }
        throw 0;
      }
    }`);
    const block = parsed?.program.body[0];
    if (!t.isBlockStatement(block) || !t.isIfStatement(block.body[0]))
      throw new Error("Expected parsed branch");
    let visits = 0;
    const prefixes = new ElectronCallPathBlockPrefixes(() => {
      visits += 1;
      return true;
    });
    const fact = prefixes.statement(block.body[0], block);
    return { visits, fact };
  };
  const small = inspect(1);
  const large = inspect(300);
  expect(small.fact).toMatchObject({ kind: "branch", consequentExits: true });
  expect(large.fact).toMatchObject({ kind: "branch", consequentExits: true });
  expect(large.visits).toBe(small.visits);
});
