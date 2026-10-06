import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

it.each([
  [
    "function declaration",
    "function run(value = helper())",
    "function helper() { return 'INNER'; }",
  ],
  [
    "body const",
    "function run(value = helper())",
    "const helper = () => 'INNER';",
  ],
  ["body var", "function run(value = helper())", "var helper = () => 'INNER';"],
  [
    "arrow",
    "const run = (value = helper()) =>",
    "const helper = () => 'INNER';",
  ],
  [
    "default closure",
    "function run(value = () => helper())",
    "function helper() { return 'INNER'; }",
  ],
  [
    "computed destructuring",
    "function run({[helper()]: value})",
    "function helper() { return 'INNER'; }",
  ],
  [
    "nested destructuring default",
    "function run({value = helper()})",
    "function helper() { return 'INNER'; }",
  ],
  [
    "method",
    "const object = { run(value = helper())",
    "function helper() { return 'INNER'; }",
  ],
])(
  "keeps %s body declarations out of parameter expressions",
  (name, declaration, body) => {
    const end = name === "method" ? "}};" : "};";
    const ir = analyzeJavaScriptSemantics(`function helper() { return 'OUTER'; }
${declaration} {
  ${body}
  const bodyValue = helper();
  return value;
${end}`);
    const outer = ir.callables.find(
      ({ name, location }) => name === "helper" && location.start.line === 1,
    );
    const inner = ir.callables.find(
      ({ name, location }) => name === "helper" && location.start.line === 3,
    );
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(
      ir.callSites.find(({ location }) => location.start.line === 2)
        ?.calleeCallableIds,
    ).toEqual([outer?.callableId]);
    expect(
      ir.callSites.find(({ location }) => location.start.line === 4)
        ?.calleeCallableIds,
    ).toEqual([inner?.callableId]);
  },
);

it("retains parameter references and argument flow across the body environment", () => {
  const ir = analyzeJavaScriptSemantics(
    `function run(first, second = first) { return first; } run('INPUT');`,
  );
  const run = onlyCallable(ir, "run");
  const first = ir.bindings.find(({ name }) => name === "first");
  expect(
    ir.references
      .filter(({ name }) => name === "first")
      .map(({ bindingId }) => bindingId),
  ).toEqual([first?.bindingId, first?.bindingId]);
  expect(ir.argumentFlows).toEqual([
    expect.objectContaining({
      callableId: run.callableId,
      parameterBindingId: first?.bindingId,
    }),
  ]);
});

it.each(["value", "{value}", "...value"])(
  "keeps expression-free %s parameters in the existing var environment",
  (parameter) => {
    const ir = analyzeJavaScriptSemantics(
      `function run(${parameter}) { var value; return value; }`,
    );
    expect(ir.bindings.filter(({ name }) => name === "value")).toHaveLength(1);
  },
);
