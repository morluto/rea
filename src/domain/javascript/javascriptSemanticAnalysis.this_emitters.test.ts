import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const emitters = (source: string) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.coverage.status).toBe("complete");
  const groups = new Map<string, string[]>();
  for (const { emitterKey, method, resolution } of ir.eventOperations)
    groups.set(emitterKey, [
      ...(groups.get(emitterKey) ?? []),
      `${method}:${resolution}`,
    ]);
  return [...groups.values()];
};

it("shares each class receiver side across members without joining static and instance fields", () => {
  expect(
    emitters(`class E {
      field = this.on('ready', handler);
      constructor() { this.emit('ready'); }
      get value() { return this.emit('ready'); }
      #remove() { this.off('ready', handler); }
      run() { (() => this.emit('ready'))(); }
      static field = this.on('ready', handler);
      static { this.emit('ready'); }
      static run() { this.off('ready', handler); }
    }`),
  ).toEqual([
    [
      "on:partial",
      "emit:partial",
      "emit:partial",
      "off:partial",
      "emit:partial",
    ],
    ["on:partial", "emit:partial", "off:partial"],
  ]);
});

it("retains separate static and instance candidate families across local inheritance", () => {
  expect(
    emitters(`
      class Base {
        run() { this.on('ready', handler); }
        static run() { this.on('ready', handler); }
      }
      class Child extends Base {
        run() { this.emit('ready'); }
        static run() { this.emit('ready'); }
      }
      class Other { run() { this.emit('ready'); } }
    `),
  ).toEqual([
    ["on:partial", "emit:partial"],
    ["on:partial", "emit:partial"],
    ["emit:partial"],
  ]);
});

it.each([
  "flag ? Base : Other",
  "Base || Other",
  "flag ? Base : external",
  "(0, Base)",
])("retains possible local base event links for %s", (base) => {
  const groups = emitters(`
    class Base { run() { this.on('ready', handler); } }
    class Other { run() { this.off('ready', handler); } }
    class Child extends (${base}) { run() { this.emit('ready'); } }
  `);
  expect(groups[0]).toContain("on:partial");
  expect(groups[0]).toContain("emit:partial");
  expect(groups.flat()).toHaveLength(3);
  expect(groups).toHaveLength(base.includes("Other") ? 1 : 2);
});

it("does not join classes merely because they name the same unknown external base", () => {
  expect(
    emitters(`
      class A extends external { field = this.on(name, handler); }
      class B extends external { field = this.emit('ready'); }
    `),
  ).toEqual([["on:unresolved"], ["emit:partial"]]);
});

it("keeps nested ordinary functions separate while member arrows inherit their class side", () => {
  expect(
    emitters(`class E {
      field = () => this.on('ready', handler);
      run() {
        (() => this.emit('ready'))();
        function inner() { this.emit('ready'); }
      }
      static field = () => this.on('ready', handler);
      static run() { (() => this.emit('ready'))(); }
    }`),
  ).toEqual([
    ["on:partial", "emit:partial"],
    ["emit:partial"],
    ["on:partial", "emit:partial"],
  ]);
});

it("keeps class definition expressions outside member receiver families", () => {
  expect(
    emitters(`function install() {
      this.on('ready', handler);
      @decorate(this.emit('ready'))
      class E extends (this.emit('ready'), Base) {
        @decorate(this.emit('ready')) run() { this.on('ready', handler); }
        [this.emit('ready')]() { this.emit('ready'); }
        [this.emit('ready')] = this.emit('ready');
      }
    }`),
  ).toEqual([
    [
      "on:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
    ],
    ["on:partial", "emit:partial", "emit:partial"],
  ]);
});

it("evaluates computed object-method keys in the enclosing receiver", () => {
  expect(
    emitters(`function install() {
      this.on('ready', handler);
      return {
        [this.emit('ready')]() { this.emit('ready'); }
      };
    }`),
  ).toEqual([["on:partial", "emit:partial"], ["emit:partial"]]);
});

it("terminates cyclic class candidates with partial event links", () => {
  expect(
    emitters(`
      class A extends B { run() { this.on('ready', handler); } }
      class B extends A { run() { this.emit('ready'); } }
    `),
  ).toEqual([["on:partial", "emit:partial"]]);
});

it("retains candidate links through a long local class chain", () => {
  const classes = ["class C0 { run() { this.on('ready', handler); } }"];
  for (let index = 1; index <= 500; index++)
    classes.push(`class C${index} extends C${index - 1} {}`);
  classes.push("class Child extends C500 { run() { this.emit('ready'); } }");
  expect(emitters(classes.join("\n"))).toEqual([
    ["on:partial", "emit:partial"],
  ]);
});
