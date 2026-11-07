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
  it("terminates recursive receiver getters", () => {
    expect(
      resultValue(
        "const box = { x: 1, get self() { return this.self; } }; box.self.x = 2; return box.x;",
      ),
    ).toMatchObject({ status: "literal", value: 1 });
  });
});

describe("getters reached through unknown receiver keys", () => {
  // Undici-style classes read `this[symbol].name` in every getter. Each
  // unknown key can select any getter again, which enumerated every getter
  // ordering and overflowed the stack on Grok Bot's main process bundle.
  const getters = Array.from(
    { length: 24 },
    (_, index) =>
      `get g${String(index)}() { return this[k].n${String(index)}; }`,
  ).join(" ");
  it.each([
    ["one unknown hop", "new R().g7.x = 2;"],
    ["a second unknown hop", "new R().g7.n3.x = 2;"],
  ])("bounds expansion and keeps writes through %s", (_shape, write) => {
    const start = performance.now();
    const value = resultValue(
      `const k = Symbol("state"); const shared = { x: 1 }; class R { constructor() { this[k] = { n7: shared }; } ${getters} } ${write} return shared.x;`,
    );
    expect(performance.now() - start).toBeLessThan(2000);
    expect(value?.status).toBe("unknown");
  });

  it("keeps a literal no getter can return", () => {
    expect(
      resultValue(
        `const k = Symbol("state"); const shared = { x: 1 }; const other = { x: 1 }; class R { constructor() { this[k] = { n7: other }; } ${getters} } new R().g7.n3.x = 2; return shared.x;`,
      ),
    ).toMatchObject({ status: "literal", value: 1 });
  });

  it("carries the active getter cycle guard through method-return widening", () => {
    const value = resultValue(`const shared = { x: 1 };
    class R {
      constructor() { this[k1] = { x: shared }; }
      method() { return this[k3].x; }
      get s() { return this.method(); }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new R().a.x = 2;
    return shared.x;`);
    expect(value?.status).toBe("unknown");
  });
});

it("widens private receiver aliases through repeated unknown getter reads", () => {
  expect(
    resultValue(`
    const shared = { x: 1 };
    class R {
      #state = { y: { x: shared } };
      get s() { return this.#state; }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new R().a.x = 2;
    return shared.x;
  `)?.status,
  ).toBe("unknown");
});

it("does not invoke ordinary or private method returns while widening a getter property read", () => {
  expect(
    resultValue(`
    const shared = { x: 1 };
    class R {
      method() { return shared; }
      #privateMethod() { return shared; }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new R().a.x = 2;
    return shared.x;
  `),
  ).toMatchObject({ status: "literal", value: 1 });
});

it("widens values returned by directly called private methods", () => {
  expect(
    resultValue(`
    const shared = { x: 1 };
    class R {
      #read() { return shared; }
      get s() { return this.#read(); }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new R().a.x = 2;
    return shared.x;
  `)?.status,
  ).toBe("unknown");
});

it("resolves a private method in its declaring class when widening an inherited getter", () => {
  expect(
    resultValue(`
    const shared = { x: 1 };
    class A {
      #read() { return shared; }
      get s() { return this.#read(); }
    }
    class B extends A {
      #read() { return {}; }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new B().a.x = 2;
    return shared.x;
  `)?.status,
  ).toBe("unknown");
});

it("does not confuse a subclass private method with an inherited getter's method", () => {
  expect(
    resultValue(`
    const shared = { x: 1 };
    class A {
      #read() { return {}; }
      get s() { return this.#read(); }
    }
    class B extends A {
      #read() { return shared; }
      get a() { return this[k1].x; }
      get b() { return this[k2].y; }
    }
    new B().a.x = 2;
    return shared.x;
  `),
  ).toMatchObject({ status: "literal", value: 1 });
});
