import { expect, it, vi } from "vitest";
import { createSemanticBuiltinSlotQuery } from "./javascriptSemanticDataEffectHelpers.js";
import * as t from "@babel/types";

import { retainSemanticAmbientEffect } from "./javascriptSemanticAmbientWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  javaScriptSourceInvocationContext,
  javaScriptGenericInvocationMethod,
  resolveJavaScriptGenericInvocation,
} from "./javascriptIntrinsicInvocation.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsSteps } from "../../../tests/fixtures/javascriptSemanticIndex.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const invocationKinds = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (ReturnType<typeof interop.intrinsicInvocation> | null)[] =
    [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        invocations.push(interop.intrinsicInvocation(node) ?? null);
    },
  });
  return invocations;
};

it("retains a possible intrinsic identity across an opaque alias read", () => {
  const facts = invocationKinds(`
    let update = Reflect.set;
    update({}, "label", 1);
    eval(source);
    update({}, "label", 2);
  `);
  expect(facts[0]).toMatchObject({
    kind: "known",
    path: ["intrinsic", "Reflect", "set"],
  });
  expect(facts.at(-1)).toMatchObject({
    kind: "opaque",
    path: ["intrinsic", "Reflect", "set"],
    arguments: undefined,
  });
});

it.each([
  'const change = Object.defineProperty.call; change(null,Object,"create",{value:customCreate});',
  'const {apply:change} = Object.defineProperty; change(null,[Object,"create",{value:customCreate}]);',
  'const change = Reflect.apply.call; change(null,Object.defineProperty,null,[Object,"create",{value:customCreate}]);',
])(
  "keeps a bare invocation member alias unknown, not effect-free: %s",
  (source) => {
    expect(invocationKinds(source)).toEqual([
      expect.objectContaining({ kind: "opaque" }),
    ]);
  },
);

it("keeps a comma-expression intrinsic call unknown when its receiver is erased", () => {
  expect(
    invocationKinds(
      '(0, Object.defineProperty.call)(null, Object, "create", {value: customCreate});',
    ),
  ).toEqual([
    expect.objectContaining({
      kind: "opaque",
      path: ["intrinsic", "Object", "defineProperty", "call"],
    }),
  ]);
});

it.each([
  ["get.call(null)", "get"],
  ["get.apply(null,[])", "get"],
  ["get.call.call(other,null)", "get.call"],
  ["get.apply.call(other,null,[])", "get.apply"],
  ["(0,get.call)(null)", undefined],
])(
  "retains one generic callable receiver transition through %s",
  (source, name) => {
    const parsed = parseJavaScriptSource(source);
    const statement = parsed?.program.body[0];
    if (
      !t.isExpressionStatement(statement) ||
      !t.isCallExpression(statement.expression)
    )
      throw new Error("Expected source invocation fixture");
    const call = statement.expression;
    const method = javaScriptGenericInvocationMethod(call.callee);
    const context = javaScriptSourceInvocationContext(call);
    const result =
      method === undefined
        ? undefined
        : resolveJavaScriptGenericInvocation(method, context);
    expect(result?.callable).toEqual(
      name === undefined
        ? undefined
        : name.includes(".")
          ? expect.objectContaining({
              type: "MemberExpression",
              object: expect.objectContaining({ name: "get" }),
              property: expect.objectContaining({ name: name.split(".")[1] }),
            })
          : expect.objectContaining({ type: "Identifier", name }),
    );
    if (name?.includes("."))
      expect(result?.context.receiver).toEqual(
        expect.objectContaining({ type: "Identifier", name: "other" }),
      );
  },
);

it("retains fixed dispatch and rereads live spread arguments", () => {
  const parsed = parseJavaScriptSource(
    "Object.getPrototypeOf([]);Object.getPrototypeOf(...[[]]);",
    "dispatch.mjs",
  );
  if (parsed === null) throw new Error("Expected dispatch fixture");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const [direct, spread] = parsed.program.body.map((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? statement.expression
      : undefined,
  );
  if (direct === undefined || spread === undefined)
    throw new Error("Expected direct and spread calls");
  let lookups = 0;
  const interop = createSemanticModuleInterop(state, {
    fixedIntrinsicPaths: true,
    intrinsicPath: () => {
      lookups += 1;
      return ["intrinsic", "Object", "getPrototypeOf"];
    },
  });
  const normalized = interop.intrinsicInvocationFacts(direct);
  expect(normalized.settled).toBe(true);
  expect(normalized.invocation?.kind).toBe("known");
  const firstLookups = lookups;
  for (let index = 0; index < 64; index++)
    expect(interop.intrinsicInvocation(direct)).toBe(normalized.invocation);
  expect(lookups).toBe(firstLookups);
  expect(interop.intrinsicInvocation(direct, undefined, () => true)?.kind).toBe(
    "opaque",
  );

  const before = interop.intrinsicInvocationFacts(spread);
  expect(before.settled).toBe(false);
  expect(before.invocation?.arguments?.[0]?.type).toBe("ArrayExpression");
  retainSemanticAmbientEffect(
    state,
    "write",
    ["array-iterator-prototype", "next"],
    undefined,
  );
  const after = interop.intrinsicInvocationFacts(spread);
  expect(after.settled).toBe(false);
  expect(after.invocation?.arguments?.[0]?.type).toBe("SpreadElement");
});

it("refreshes settled dispatch when its owner records an earlier replacement", () => {
  const parsed = parseJavaScriptSource(
    "Object.getPrototypeOf = replacement; Object.getPrototypeOf([]);",
    "captured-dispatch.mjs",
  );
  if (parsed === null) throw new Error("Expected dispatch fixture");
  const [write, read] = parsed.program.body;
  if (!t.isExpressionStatement(read) || !t.isCallExpression(read.expression))
    throw new Error("Expected invocation");
  if (write === undefined) throw new Error("Expected earlier effect site");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const path = ["intrinsic", "Object", "getPrototypeOf"];
  const interop = createSemanticModuleInterop(state, {
    fixedIntrinsicPaths: true,
    intrinsicPath: () => path,
  });
  const original = interop.intrinsicInvocationFacts(read.expression);
  expect(original).toMatchObject({
    invocation: { kind: "known" },
    settled: true,
  });
  expect(interop.intrinsicInvocationFacts(read.expression)).toBe(original);
  interop.retainWrite(write, path);
  const changed = interop.intrinsicInvocationFacts(read.expression);
  expect(changed).toMatchObject({
    invocation: { kind: "opaque", path },
    settled: true,
  });
  expect(interop.intrinsicInvocationFacts(read.expression)).toBe(changed);
});

it("preserves a Reflect method captured before a deferred change", () => {
  const parsed = parseJavaScriptSource(
    "const set=Reflect.set; function update(){Reflect.set=other} update(); set({}, 'label', 1);",
  );
  if (!parsed) throw new Error("Expected a program");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const [, declaration, , read] = parsed.program.body;
  if (
    !t.isFunctionDeclaration(declaration) ||
    !t.isExpressionStatement(read) ||
    !t.isCallExpression(read.expression)
  )
    throw new Error("Expected a function and a call");
  const write = declaration.body.body[0];
  if (!t.isExpressionStatement(write))
    throw new Error("Expected a deferred assignment");
  interop.retainWrite(write.expression, ["intrinsic", "Reflect", "set"]);
  expect(interop.intrinsicInvocation(read.expression)).toMatchObject({
    kind: "known",
    path: ["intrinsic", "Reflect", "set"],
  });
});

it("propagates an uncertain inherited descriptor field at its read site", () => {
  const parsed = parseJavaScriptSource(
    "Object.defineProperty(Reflect, 'set', {enumerable: true}); const read = Reflect.set;",
  );
  if (!parsed) throw new Error("Expected a program");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const [definition, declaration] = parsed.program.body;
  if (
    !t.isExpressionStatement(definition) ||
    !t.isVariableDeclaration(declaration)
  )
    throw new Error("Expected a definition and read");
  const read = declaration.declarations[0]?.init;
  if (!read) throw new Error("Missing selected method");
  expect(interop.intrinsicValueReferences(read, () => false)).toMatchObject([
    { path: ["value"] },
  ]);
  expect(
    interop.intrinsicValueReferences(
      read,
      (mutation, key) => mutation === definition.expression && key === "set",
    ),
  ).toBeUndefined();
});

it("reuses builtin receiver evidence within one mutation epoch and refreshes on the next", () => {
  const parsed = parseJavaScriptSource("const input = 1;");
  if (!parsed) throw new Error("Expected a program");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const effects = state.requiredModuleEffects;
  const reads = vi.spyOn(effects, "get");
  try {
    let revision = 0;
    const slotChanged = createSemanticBuiltinSlotQuery(state, () => revision);
    const fs = { specifier: "fs", importedPath: [] };
    const read = parsed.program;
    expect(slotChanged(fs, "stat", read)).toBe(false);
    const firstReads = reads.mock.calls.length;
    expect(firstReads).toBeGreaterThan(0);
    expect(slotChanged(fs, "stat", read)).toBe(false);
    expect(reads.mock.calls).toHaveLength(firstReads);
    effects.set("fs", [{ kind: "write", path: ["stat"], node: undefined }]);
    revision++;
    expect(slotChanged(fs, "stat", read)).toBe(true);
  } finally {
    reads.mockRestore();
  }
});
