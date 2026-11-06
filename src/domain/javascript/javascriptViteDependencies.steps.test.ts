import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { semanticEffectStatementPosition } from "./javascriptSemanticMutationInitializers.js";
import { classifyParsedJavaScriptViteDependencySpecifiersSteps } from "./javascriptViteDependencies.js";

it.each(["prototype copy", "property snapshot"])(
  "bounds ordering work for a wide %s group",
  (kind) => {
    const snapshot = kind === "property snapshot";
    const count = snapshot ? 8193 : 3073;
    const source = snapshot
      ? 'const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = ["./first.js"]))) => i.map(j => d[j]); const box = {cache: 0};\n' +
        Array.from({ length: count }, () => "box.cache = 1;").join("\n") +
        "\nopaque(box.cache); __vite__mapDeps([0]);"
      : 'const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = ["./first.js"]))) => i.map(j => d[j]); const proto = Array.prototype;\n' +
        Array.from(
          { length: count },
          (_, i) => `proto.slot${i} = ${i}; opaque(proto);`,
        ).join("\n") +
        "\nconst copy = {...proto}; opaque(copy); __vite__mapDeps([0]);";
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("expected parsed ordering fixture");
    const bindings = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const seen = new Set<object>();
    let reads = 0;
    traverseJavaScriptAst(parsed.program, {
      enter(node) {
        if (!t.isAssignmentExpression(node) && !t.isCallExpression(node))
          return;
        const position = semanticEffectStatementPosition(
          node,
          bindings.parentsByNode,
        );
        if (position === null || seen.has(position)) return;
        seen.add(position);
        const index = position.index;
        Object.defineProperty(position, "index", {
          get() {
            reads++;
            return index;
          },
        });
      },
    });
    const steps = classifyParsedJavaScriptViteDependencySpecifiersSteps(
      parsed,
      bindings,
    );
    let previous = 0;
    for (;;) {
      const step = steps.next();
      expect(reads - previous).toBeLessThanOrEqual(8192);
      previous = reads;
      if (step.done) {
        expect(step.value.size).toBe(1);
        expect([...step.value.values()]).toEqual(
          snapshot ? [["./first.js"]] : [[undefined]],
        );
        break;
      }
    }
    expect(reads).toBeGreaterThan(count);
  },
);

it.each([false, true])(
  "bounds Vite table, mapper and index work per step (supplied mapper: %s)",
  (suppliedMapper) => {
    const count = 3073;
    const values = Array.from(
      { length: count },
      (_, index) => `./dependency-${index}.js`,
    );
    const indexes = Array.from({ length: count }, (_, index) => index);
    const source =
      "const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = " +
      JSON.stringify(values) +
      "))) => i.map(j => d[j]);\n__vite__mapDeps(" +
      JSON.stringify(indexes) +
      (suppliedMapper
        ? ", {f:" +
          JSON.stringify(values) +
          "," +
          indexes.map((index) => `slot${index}:0`).join(",") +
          "}"
        : "") +
      ").filter(Boolean);";
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("expected parsed Vite fixture");
    const bindings = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const arrays: t.ArrayExpression[] = [];
    const mappers: t.ObjectExpression[] = [];
    let call: t.CallExpression | undefined;
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (t.isObjectExpression(node) && node.properties.length > count)
          mappers.push(node);
        if (t.isArrayExpression(node) && node.elements.length === count)
          arrays.push(node);
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "__vite__mapDeps" })
        )
          call = node;
      },
    });
    expect(arrays).toHaveLength(suppliedMapper ? 3 : 2);
    expect(mappers).toHaveLength(suppliedMapper ? 1 : 0);
    if (call === undefined) throw new Error("expected the exact helper call");
    let reads = 0;
    for (const array of arrays)
      array.elements = new Proxy(array.elements, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    for (const mapper of mappers)
      mapper.properties = new Proxy(mapper.properties, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    const steps = classifyParsedJavaScriptViteDependencySpecifiersSteps(
      parsed,
      bindings,
    );
    let previousReads = 0;
    let yields = 0;
    let step = steps.next();
    for (;;) {
      // composed phase tails may share a step; a complete fixture array may not.
      expect(reads - previousReads).toBeLessThanOrEqual(2048);
      previousReads = reads;
      if (step.done === true) break;
      yields += 1;
      step = steps.next();
    }
    expect(yields).toBeGreaterThan(1);
    // Wide projections must index positional layout once, rather than rescan
    // every prefix for each returned slot, even when each scan yields fairly.
    expect(reads).toBeLessThan(count * (suppliedMapper ? 128 : 64));
    expect(step.value.size).toBe(1);
    expect([...step.value.keys()]).toEqual([call]);
    expect(step.value.get(call)).toEqual(suppliedMapper ? [undefined] : values);
  },
);
