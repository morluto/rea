import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const resultValue = (body: string) =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() { ${body} }`),
    "result",
  ).returnSites[0]?.value;

const getterReceivers = [
  [
    "this",
    "const box = { x: 1, get self() { return this; } }; box.self.x = 2; return box.x;",
  ],
  [
    "this property",
    "const shared = { x: 1 }; const box = { s: shared, get v() { return this.s; } }; box.v.x = 2; return shared.x;",
  ],
  [
    "private field",
    "const shared = { x: 1 }; class B { #s = shared; get v() { return this.#s; } } new B().v.x = 2; return shared.x;",
  ],
  [
    "super getter",
    "const shared = { x: 1 }; class A { get v() { return shared; } } class B extends A { get v() { return super.v; } } new B().v.x = 2; return shared.x;",
  ],
  [
    "saved receiver alias",
    "const box = { x: 1, get self() { return this; } }; const alias = box.self; alias.x = 2; return box.x;",
  ],
  [
    "nested owner",
    "const outer = { box: { x: 1, get self() { return this; } } }; outer.box.self.x = 2; return outer.box.x;",
  ],
  [
    "array element",
    "const arr = [{ x: 1, get self() { return this; } }]; arr[0].self.x = 2; return arr[0].x;",
  ],
  [
    "array element after a hole",
    "const arr = [, { x: 1, get self() { return this; } }]; arr[1].self.x = 2; return arr[1].x;",
  ],
  [
    "mixed object and array owners",
    "const outer = { rows: [{ box: { x: 1, get self() { return this; } } }] }; outer.rows[0].box.self.x = 2; return outer.rows[0].box.x;",
  ],
  [
    "assigned owner",
    "let box; box = { x: 1, get self() { return this; } }; box.self.x = 2; return box.x;",
  ],
  [
    "saved array receiver alias",
    "const arr = [{ x: 1, get self() { return this; } }]; const saved = arr[0].self; saved.x = 2; return arr[0].x;",
  ],
  [
    "old receiver captured inside its replacement initializer",
    "const old = { x: 1 }; let box = old; box = { old: box, get self() { return this; } }; box.self.old.x = 2; return old.x;",
  ],
  [
    "array receiver after an unknown spread",
    "const arr = [...items, { x: 1, get self() { return this; } }]; arr[index].self.x = 2; return arr[index].x;",
  ],
  [
    "saved receiver before its array alias is reassigned",
    "const original = [{ x: 1, get self() { return this; } }]; let arr = original; const saved = arr[0].self; arr = [{ x: 1 }]; saved.x = 2; return original[0].x;",
  ],
  [
    "inherited receiver field",
    "const shared = { x: 1 }; class A { get v() { return this.s; } } class B extends A { s = shared; } new B().v.x = 2; return shared.x;",
  ],
  [
    "super receiver field",
    "const shared = { x: 1 }; class A { get v() { return this.s; } } class B extends A { s = shared; get v() { return super.v; } } new B().v.x = 2; return shared.x;",
  ],
  [
    "static private field",
    "const shared = { x: 1 }; class B { static #s = shared; static get v() { return this.#s; } } B.v.x = 2; return shared.x;",
  ],
  [
    "inherited field",
    "const shared = { x: 1 }; class A { s = shared; } class B extends A { get v() { return this.s; } } new B().v.x = 2; return shared.x;",
  ],
  [
    "class getter chain",
    "const shared = { x: 1 }; class B { get s() { return shared; } get v() { return this.s; } } new B().v.x = 2; return shared.x;",
  ],
  [
    "inherited field shadows prototype getter",
    "const shared={x:1};class A{s=shared}class B extends A{get s(){return {x:1}} get v(){return this.s}}new B().v.x=2;return shared.x;",
  ],
  [
    "alternative inherited fields",
    "const shared={x:1};const Base=flag?class{s={x:1}}:class{s=shared};class B extends Base{get v(){return this.s}}new B().v.x=2;return shared.x;",
  ],
  [
    "alternative inherited getter",
    "const shared={x:1};const Base=flag?class{s={x:1}}:class{get s(){return shared}};class B extends Base{get v(){return this.s}}new B().v.x=2;return shared.x;",
  ],
  [
    "repeated class receiver",
    "const shared={x:1};class B{s=shared;get self(){return this}}new B().self.self.s.x=2;return shared.x;",
  ],
  [
    "getter chain",
    "const shared = { x: 1 }; const box = { s: shared, get self() { return this; }, get v() { return this.self.s; } }; box.v.x = 2; return shared.x;",
  ],
] as const;

describe("getter receiver mutation aliases (#1665, #2654)", () => {
  it.each(getterReceivers)(
    "does not report a stale literal through %s",
    (_shape, body) => {
      expect(resultValue(body)?.status).toBe("unknown");
    },
  );
  it.each([
    [
      "duplicate field",
      "const shared={x:1};class B{s=shared;s={x:1};get v(){return this.s}}new B().v.x=2;return shared.x;",
    ],
    [
      "super excludes instance fields",
      "const shared={x:1};class A{s=shared}class B extends A{get v(){return super.s ?? {x:1}}}new B().v.x=2;return shared.x;",
    ],
    [
      "fresh return",
      "const shared = { x: 1 }; const box = { get v() { return { x: 1 }; } }; box.v.x = 2; return shared.x;",
    ],
    [
      "read without write",
      "const box = { x: 1, get self() { return this; } }; const alias = box.self; return box.x;",
    ],
    [
      "unrelated sibling",
      "const box = { x: 1, y: 1, get self() { return this; } }; box.self.y = 2; return box.x;",
    ],
    [
      "array receiver read without write",
      "const arr = [{ x: 1, get self() { return this; } }]; const saved = arr[0].self; return arr[0].x;",
    ],
    [
      "assigned receiver read without write",
      "let box; box = { x: 1, get self() { return this; } }; const saved = box.self; return box.x;",
    ],
    [
      "unrelated array receiver property",
      "const arr = [{ x: 1, y: 1, get self() { return this; } }]; arr[0].self.y = 2; return arr[0].x;",
    ],
    [
      "unrelated array element",
      "const arr = [{ x: 1, get self() { return this; } }, { x: 1 }]; arr[0].self.x = 2; return arr[1].x;",
    ],
    [
      "array replacement after a receiver was captured",
      "const original = [{ x: 1, get self() { return this; } }]; const replacement = [{ x: 1 }]; let arr = original; const saved = arr[0].self; arr = replacement; saved.x = 2; return replacement[0].x;",
    ],
    [
      "known array prefix before a spread receiver",
      "const arr = [{ x: 1 }, ...items, { x: 1, get self() { return this; } }]; arr[1].self.x = 2; return arr[0].x;",
    ],
    [
      "outer binding shadowed by an assigned receiver",
      "let box; box = { x: 1 }; { let box; box = { x: 1, get self() { return this; } }; box.self.x = 2; } return box.x;",
    ],
    [
      "old object before an unconditional receiver assignment",
      "const old = { x: 1 }; let box = old; box = { x: 1, get self() { return this; } }; box.self.x = 2; return old.x;",
    ],
    [
      "unmodified old receiver captured inside its replacement initializer",
      "const old = { x: 1 }; let box = old; box = { x: 1, old: box, get self() { return this; } }; box.self.x = 2; return old.x;",
    ],
    [
      "replace getter",
      "const shared = { x: 1 }; const box = { s: shared, get v() { return this.s; } }; box.v = {}; return shared.x;",
    ],
    [
      "delete getter",
      "const shared = { x: 1 }; const box = { s: shared, get v() { return this.s; } }; delete box.v; return shared.x;",
    ],
    [
      "ordinary method read",
      "const box = { x: 1, self() { return this; } }; const method = box.self; return box.x;",
    ],
  ])("preserves a known literal for %s", (_shape, body) => {
    expect(resultValue(body)).toMatchObject({ status: "literal", value: 1 });
  });
  it.each([
    ["class computed method key", "class { [(this.x = 2, 'k')]() {} }"],
    ["class computed field key", "class { [(this.x = 2, 'k')] = 0; }"],
    ["superclass expression", "class extends (this.x = 2, Object) {}"],
    [
      "nested class key",
      "class extends (class { [(this.x = 2, 'k')]() {} }) {}",
    ],
    ["object method computed key", "({ [(this.x = 2, 'k')]() {} })"],
  ])("invalidates the receiver after a %s write", (_label, result) => {
    expect(
      resultValue(
        `const box = { x: 1, get trigger() { return ${result}; } }; box.trigger; return box.x;`,
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it.each([
    ["class computed method key", "class { [this]() {} }"],
    ["class computed field key", "class { [this] = 0; }"],
    ["object method computed key", "({ [this]() {} })"],
  ])("invalidates the receiver when a %s converts it", (_label, result) => {
    expect(
      resultValue(
        `const box = { x: 1, toString() { this.x = 2; return 'k'; }, get trigger() { return ${result}; } }; box.trigger; return box.x;`,
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it.each([
    ["uninvoked class method", "class { method() { this.x = 2; } }"],
    [
      "uninvoked computed class method",
      "class { [(0, 'k')]() { this.x = 2; } }",
    ],
    ["uninvoked computed object method", "({ [(0, 'k')]() { this.x = 2; } })"],
    ["instance field initializer", "class { f = (this.x = 2); }"],
    ["static field receiver", "class { static s = (this.x = 2); }"],
    ["static block receiver", "class { static { this.x = 2; } }"],
  ])("keeps the receiver value through a %s", (_label, result) => {
    expect(
      resultValue(
        `const box = { x: 1, get trigger() { return ${result}; } }; box.trigger; return box.x;`,
      ),
    ).toMatchObject({ status: "literal", value: 1 });
  });

  it.each([
    ["static block", "class { static { self.x = 2; } }"],
    ["static field value", "class { static s = (self.x = 2); }"],
    [
      "static block of a nested heritage class",
      "class extends (class { static { self.x = 2; } }) {}",
    ],
  ])(
    "invalidates the receiver after a %s writes through a captured alias",
    (_label, result) => {
      expect(
        resultValue(
          `const box = { x: 1, get trigger() { const self = this; return ${result}; } }; box.trigger; return box.x;`,
        ),
      ).toMatchObject({ status: "unknown" });
    },
  );

  it("terminates recursive receiver getters", () => {
    expect(
      resultValue(
        "const box = { x: 1, get self() { return this.self; } }; box.self.x = 2; return box.x;",
      ),
    ).toMatchObject({ status: "literal", value: 1 });
  });
});
