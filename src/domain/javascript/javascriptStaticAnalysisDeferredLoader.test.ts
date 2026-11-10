import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

/**
 * A `createRequire` loader saved under a member literally named `require` is still
 * the same loader. The deferred path used to drop the loader identity, so the
 * specifier of a factory or `create-require` module key read as an external package.
 *
 * Measured shape:
 *
 *   import { createRequire } from "node:module";
 *   const holder = { require: createRequire(import.meta.url) };
 *   holder.require("x");            -> a `create-require` load of "x"
 *
 * A plain `module.require` member is the CommonJS loader, so it stays unqualified.
 */
const referencesFor = (source: string) =>
  (analyzeJavaScriptStaticSource(source).references ?? []).map(
    ({ kind, specifier, loader }) => ({ kind, specifier, loader }),
  );

it("forwards createRequire through a member named require", () => {
  expect(
    referencesFor(
      `import { createRequire } from "node:module";
const holder = { require: createRequire(import.meta.url) };
holder.require("x");`,
    ),
  ).toEqual([
    { kind: "static-import", specifier: "node:module", loader: undefined },
    { kind: "require", specifier: "x", loader: "create-require" },
  ]);
});

it("forwards a destructured require member alias", () => {
  expect(
    referencesFor(
      `import { createRequire } from "node:module";
const { require: load } = { require: createRequire(import.meta.url) };
load("y");`,
    ),
  ).toEqual([
    { kind: "static-import", specifier: "node:module", loader: undefined },
    { kind: "require", specifier: "y", loader: "create-require" },
  ]);
});

it("keeps a module.require member unqualified", () => {
  // A bare snippet has no `module` binding, so the specifier stays unresolved; what
  // this pins is that the deferred path does not invent a loader identity for it.
  expect(referencesFor(`const load = module.require; load("z");`)).toEqual([
    { kind: "require", specifier: null, loader: undefined },
  ]);
});
