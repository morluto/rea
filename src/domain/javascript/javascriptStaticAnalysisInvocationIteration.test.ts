import { runInNewContext } from "node:vm";
import * as t from "@babel/types";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { semanticRequireCallAt } from "./javascriptSemanticRequireOrigin.js";
import { expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const changedIterator =
  "Array.prototype[Symbol.iterator]=function*(){yield '../shared/window.cjs'};";
const cases = [
  [
    "ordinary spread",
    "",
    "require(...['./inert.cjs'])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "ordinary nested spread",
    "",
    "require(...[...['./inert.cjs']])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "changed direct spread",
    changedIterator,
    "require(...['./inert.cjs'])",
    "../shared/window.cjs",
    null,
  ],
  [
    "changed nested spread",
    changedIterator,
    "require(...[...['./inert.cjs']])",
    "../shared/window.cjs",
    null,
  ],
  [
    "changed generic call spread",
    changedIterator,
    "require.call(null,...['./inert.cjs'])",
    "../shared/window.cjs",
    null,
  ],
  [
    "changed apply argument spread",
    changedIterator,
    "require.apply(null,[...['./inert.cjs']])",
    "../shared/window.cjs",
    null,
  ],
  [
    "changed reflected argument spread",
    changedIterator,
    "Reflect.apply(require,null,[...['./inert.cjs']])",
    "../shared/window.cjs",
    null,
  ],
  [
    "apply arraylike without spread",
    changedIterator,
    "require.apply(null,['./inert.cjs'])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "reflected arraylike without spread",
    changedIterator,
    "Reflect.apply(require,null,['./inert.cjs'])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "known argument before custom spread",
    changedIterator,
    "require('./inert.cjs',...[])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "shadowed Array mutation",
    "const Array={prototype:{}};Array.prototype[Symbol.iterator]=function*(){yield '../shared/window.cjs'};",
    "require(...['./inert.cjs'])",
    "./inert.cjs",
    "./inert.cjs",
  ],
  [
    "ordinary captured generic spread",
    "const get=()=>module;const invoke=get.call;",
    "invoke.call(...[get,null]).require('./inert.cjs')",
    "./inert.cjs",
    null,
  ],
  [
    "changed captured generic spread receiver",
    "const get=()=>({});const invoke=get.call;Array.prototype[Symbol.iterator]=function*(){yield ()=>module;yield null;};",
    "invoke.call(...[get,null]).require('./inert.cjs')",
    "./inert.cjs",
    null,
  ],
] as const;

it.each(cases)(
  "retains invocation iterator authority for %s",
  (_name, setup, call, actual, specifier) => {
    const source = `${setup}${call};`;
    expect(
      runInNewContext(
        source,
        {
          require: (request: string) => request,
          module: { require: (request: string) => request },
        },
        { timeout: 1_000 },
      ),
    ).toBe(actual);
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.references).toEqual([
      expect.objectContaining({
        kind: "require",
        specifier,
        ...(specifier === null ? {} : { loader_authority: "candidate" }),
      }),
    ]);
  },
);

it.each(["call", "apply"])(
  "keeps overwritten require.%s unresolved",
  (method) => {
    for (const path of ["fixture.MJS", "fixture.cjs"]) {
      const argument =
        method === "call" ? 'null,"./a.cjs"' : 'null,["./a.cjs"]';
      const source = `require.${method}=custom;require.${method}(${argument});`;
      const unrelated = `require.other=custom;require.${method}(${argument});`;
      const parse = (text: string) => {
        const parsed = parseJavaScriptSource(text, path);
        if (parsed === null) throw new Error("fixture did not parse");
        return analyzeParsedJavaScriptStaticSource(text, parsed).references.at(
          -1,
        );
      };
      expect(parse(source)).toMatchObject({ kind: "require", specifier: null });
      expect(parse(unrelated)).toMatchObject({
        kind: "require",
        specifier: "./a.cjs",
        ...(path === "fixture.MJS"
          ? { loader_authority: "candidate" }
          : { loader: "commonjs-loader" }),
      });
    }
  },
);

it("does not prove invocation members before the mutation index is complete", () => {
  const source = 'require.call=custom;require?.call(null,"./a.cjs");';
  const parsed = parseJavaScriptSource(source, "fixture.cjs");
  if (parsed === null) throw new Error("fixture did not parse");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const statement = parsed.program.body[1];
  if (
    !t.isExpressionStatement(statement) ||
    !t.isOptionalCallExpression(statement.expression)
  )
    throw new Error("expected optional call");
  const fact = semanticRequireCallAt(
    statement.expression,
    index.bindings,
    new Set(),
    index,
  );
  expect(fact).toMatchObject({ loader: "unknown", memberUnproven: true });
});

it("does not turn a mutated local callable into a loader candidate", () => {
  const source =
    'const f=()=>0;f.call=()=>0;const addon=f.call(null,"./x.node");';
  const parsed = parseJavaScriptSource(source, "fixture.cjs");
  if (parsed === null) throw new Error("fixture did not parse");
  const result = analyzeParsedJavaScriptStaticSource(source, parsed);
  expect(result.references).toEqual([]);
  expect(result.electron.native_addon_bindings).toEqual([]);
  expect(result.parse_status).toBe("complete");
});
