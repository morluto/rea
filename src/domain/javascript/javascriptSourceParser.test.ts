import { expect, it } from "vitest";
import * as t from "@babel/types";

import {
  parseJavaScriptSource,
  parseRecoveredJavaScript,
  javaScriptRuntimeContext,
  javaScriptProgramStrictness,
  javaScriptThisOwner,
} from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { analyzeParsedJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

it("parses a class extending a local binding named module", () => {
  const source = "const module = Array; class Cards extends module {}";
  const path = "cards.mjs";
  for (const file of [
    parseJavaScriptSource(source, path),
    parseRecoveredJavaScript(source, path, {}).file,
  ]) {
    expect(file?.errors).toHaveLength(0);
    expect(file?.program.body[1]).toMatchObject({
      type: "ClassDeclaration",
      superClass: { type: "Identifier", name: "module" },
    });
  }
});

it("keeps omitted call arguments with their own list", () => {
  const source = 'outer<Pair<A, B>>(, inner(, "a,b"), /* , */ , (1, 2),,)';
  for (const file of [
    parseJavaScriptSource(source, "example.ts"),
    parseRecoveredJavaScript(source, "example.ts", {}).file,
  ]) {
    const statement = file?.program.body[0];
    if (
      !t.isExpressionStatement(statement) ||
      !t.isCallExpression(statement.expression)
    )
      throw new Error("Expected the outer call");
    const outer = statement.expression;
    expect(outer.arguments.map((arg) => arg?.type ?? null)).toStrictEqual([
      null,
      "CallExpression",
      null,
      "SequenceExpression",
      null,
    ]);
    const inner = outer.arguments[1];
    if (!t.isCallExpression(inner)) throw new Error("Expected the inner call");
    expect(inner.arguments).toMatchObject([null, { type: "StringLiteral" }]);
  }
});

it.each([
  ["class C extends (this.marker, Object) {}", true],
  ["class C { [this.marker]() {} }", true],
  ["class C { [this.marker] = 1 }", true],
  ["({[this.marker]() {}})", true],
  ["class C { value = this.marker }", false],
  ["class C { static value = this.marker }", false],
  ["class C { static { this.marker } }", false],
  ["class C { method() { this.marker } }", false],
  ["function f() { return class C extends (this.marker, Object) {} }", false],
  ["class C { value = class D { [this.marker]() {} } }", false],
  ["(() => class C { [this.marker]() {} })()", true],
] as const)(
  "owns definition-time this separately from class bodies: %s",
  (source, expected) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected parsed fixture");
    const parents = new WeakMap<t.Node, t.Node>();
    let selected: t.ThisExpression | undefined;
    traverseJavaScriptAst(parsed.program, {
      enter(node, parent) {
        if (parent !== null) parents.set(node, parent);
        if (t.isThisExpression(node)) selected = node;
      },
    });
    if (selected === undefined) throw new Error("Missing this fixture");
    expect(
      javaScriptThisOwner(selected, parsed.program, parents) === "global",
    ).toBe(expected);
  },
);

it.each([
  ['import type {T} from "example";', "fixture.cts", "commonjs"],
  ['import type {T} from "example";', "fixture.mts", "module"],
  ['import type {T} from "example";', "fixture.ts", "unknown"],
  ['import cp = require("node:child_process");', "fixture.ts", "module"],
  ['import type cp = require("node:child_process");', "fixture.ts", "unknown"],
  ["const value=[]; export = value;", "fixture.ts", "commonjs"],
  ['export type {T} from "example";', "fixture.ts", "unknown"],
  ['import {type T} from "example";', "fixture.ts", "unknown"],
  ['export {type T} from "example";', "fixture.ts", "unknown"],
  ["export declare const value: unknown;", "fixture.ts", "unknown"],
  ["export default function f(): void;", "fixture.ts", "unknown"],
  ["export default interface I {}", "fixture.ts", "unknown"],
  ["export default function f() {}", "fixture.ts", "module"],
  ["export default class C {}", "fixture.ts", "module"],
  ['import {} from "example";', "fixture.js", "module"],
  ['import {} from "example";', "fixture.cjs", "commonjs"],
  ["export {};", "fixture.ts", "module"],
  ["const value = 1;", "fixture.mjs", "module"],
  ["const value = 1;", "fixture.js", "unknown"],
  ["const value = 1;", "fixture.cjs", "commonjs"],
  ["const value = 1;", "fixture.cts", "commonjs"],
  ["declare const value: unknown;", "fixture.d.cts", "unknown"],
] as const)(
  "keeps runtime context consistent across parser entries: %s (%s)",
  (source, path, context) => {
    const parsed = parseJavaScriptSource(source, path);
    if (parsed === null) throw new Error("Expected parsed source");
    const recovered = parseRecoveredJavaScript(source, path, {}).file;
    expect(javaScriptRuntimeContext(parsed.program)).toBe(context);
    expect(javaScriptRuntimeContext(recovered.program)).toBe(context);
    expect(javaScriptRuntimeContext(t.cloneNode(parsed.program, true))).toBe(
      "unknown",
    );
  },
);

it.each([
  ["const args=[]; export = args;", "fixture.ts", "sloppy"],
  ['"use strict"; const args=[]; export = args;', "fixture.ts", "strict"],
  ['import type {T} from "example";', "fixture.ts", "unknown"],
  ["const args=[];", "fixture.mjs", "strict"],
  ["const args=[];", "fixture.cjs", "sloppy"],
] as const)(
  "owns program strictness independently of parser syntax: %s (%s)",
  (source, path, strictness) => {
    const parsed = parseJavaScriptSource(source, path);
    if (parsed === null) throw new Error("Expected parsed source");
    expect(javaScriptProgramStrictness(parsed.program)).toBe(strictness);
    const recovered = parseRecoveredJavaScript(source, path, {}).file;
    expect(javaScriptProgramStrictness(recovered.program)).toBe(strictness);
  },
);

const analyze = (source: string, path: string) => {
  const parsed = parseJavaScriptSource(source, path);
  return parsed === null
    ? null
    : {
        errors: parsed.errors.length,
        facts: analyzeParsedJavaScriptStaticSource(source, parsed),
      };
};

it("parses conditional arrow bodies in JavaScript sources with JavaScript grammar", () => {
  // Bundlers emit this shape; TypeScript reads `):H=>` as a return type.
  const source = `const {ipcMain}=require("electron");
const pick=n===0?H=>({start:H.startY}):H=>({start:H.startX});
ipcMain.handle("layout:ready",()=>pick);`;
  for (const path of ["main.js", "main.cjs", "main.mjs", "main.jsx"]) {
    const result = analyze(source, path);
    expect(result?.errors).toBe(0);
    if (path === "main.mjs") {
      expect(result?.facts.electron.ipc).toEqual([]);
    } else {
      expect(result?.facts.electron.ipc).toContainEqual(
        expect.objectContaining({
          channel: "layout:ready",
          operation: "handle",
          ...(path === "main.cjs" ? {} : { loader_authority: "candidate" }),
        }),
      );
    }
  }
});

it("keeps JavaScript comparison meaning for angle brackets in JavaScript sources", () => {
  const source = `const a=fetch<limit>("/api/compare");`;
  expect(analyze(source, "main.js")?.facts.endpoints).toEqual([]);
  expect(analyze(source, "main.ts")?.facts.endpoints).toContainEqual(
    expect.objectContaining({ value: "/api/compare" }),
  );
});

it("keeps TypeScript syntax available for TypeScript and unnamed sources", () => {
  const source = "let count: number = 1; export type Id = string;";
  expect(parseJavaScriptSource(source, "value.ts")?.errors).toEqual([]);
  expect(parseJavaScriptSource(source)?.errors).toEqual([]);
});
