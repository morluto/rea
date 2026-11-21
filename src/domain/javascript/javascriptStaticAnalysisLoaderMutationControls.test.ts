import { createRequire } from "node:module";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

const named = "import {createRequire as make} from 'node:module';";
const namespace = "import * as mod from 'node:module';";
const cases = [
  {
    name: "own call replacement",
    prefix: named,
    body: (base: string) =>
      `const load=make(${base});load.call=()=>({kind:'local'});load.call(null,'node:path');`,
    host: false,
  },
  {
    name: "own apply replacement",
    prefix: named,
    body: (base: string) =>
      `const load=make(${base});load.apply=()=>({kind:'local'});load.apply(null,['node:path']);`,
    host: false,
  },
  {
    name: "callable captured before method replacement",
    prefix: named,
    body: (base: string) =>
      `const load=make(${base});const saved=load;load.call=()=>({kind:'local'});saved('node:path');`,
    host: true,
  },
  {
    name: "mutable default factory replacement",
    prefix: namespace,
    body: (base: string) =>
      `mod.default.createRequire=()=>()=>({kind:'local'});const load=mod.default.createRequire(${base});load('node:path');`,
    host: false,
  },
  {
    name: "factory captured before its default slot replacement",
    prefix: namespace,
    body: (base: string) =>
      `const make=mod.default.createRequire;mod.default.createRequire=()=>()=>({kind:'local'});const load=make(${base});load('node:path');`,
    host: true,
  },
  {
    name: "loader created before its default factory replacement",
    prefix: namespace,
    body: (base: string) =>
      `const load=mod.default.createRequire(${base});mod.default.createRequire=()=>()=>({kind:'local'});load('node:path');`,
    host: true,
  },
];

it.each(cases)(
  "keeps loader and selected member identity for $name",
  ({ prefix, body, host }) => {
    // The mutable namespace default belongs to this VM fixture. Native created
    // require functions retain their real Node behavior without patching builtins.
    const result = runInNewContext(body("base"), {
      make: createRequire,
      mod: { default: { createRequire } },
      base: import.meta.url,
    });
    expect(result.join === path.join).toBe(host);
    if (!host) expect(result.kind).toBe("local");
    const analysis = analyzeJavaScriptStaticSource(
      `${prefix}${body("import.meta.url")}`,
    );
    expect(analysis.parse_error_count).toBe(0);
    expect(
      analysis.references.filter(({ kind }) => kind === "require"),
    ).toEqual(
      host
        ? [expect.objectContaining({ kind: "require", specifier: "node:path" })]
        : [],
    );
  },
);

it("uses the restored call member after a local replacement", () => {
  const source = `${named}const load=make(import.meta.url);load.call=()=>({kind:'local'});load.call=Function.prototype.call;load.call(null,'node:path');`;
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.references.filter(({ kind }) => kind === "require")).toEqual([
    expect.objectContaining({ kind: "require", specifier: null }),
  ]);
});
