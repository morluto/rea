import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  onlyBinding,
  onlyCallable,
} from "./javascriptSemanticAnalysis.fixture.js";
import {
  bundledGetterSource,
  getterExpansionSource,
  plainGetterSource,
  ordinaryConstructedEscapeSource,
} from "../../../tests/fixtures/javascriptGetterExpansion.js";

const permutationSource = (count: number, isStatic: boolean) => {
  const getterPrefix = isStatic ? "static " : "";
  const access = isStatic ? "Request.field0" : "new Request().field0";
  const getters = Array.from(
    { length: count },
    (_, index) =>
      `${getterPrefix}get field${index}() { return this[key].field${index}; }`,
  ).join("\n");
  return `
    import imported from "dep";
    const shared = { value: 1 };
    class Request {
      ${getters}
      ${getterPrefix}get state() { return shared; }
    }
    consume(${access});
    const result = shared.value;
    const unrelated = 42;
  `;
};

const expectRetainedFacts = (
  ir: ReturnType<typeof analyzeJavaScriptSemantics>,
) => {
  expect(onlyBinding(ir, "unrelated").value).toEqual({
    status: "literal",
    value: 42,
  });
  expect(onlyBinding(ir, "imported").provenance.status).toBe("module");
  expect(ir.moduleLinks).toContainEqual(
    expect.objectContaining({ kind: "import", specifier: "dep" }),
  );
};

it.each([false, true])(
  "bounds unknown-key %s getter permutations and preserves unrelated facts",
  (isStatic) => {
    const ir = analyzeJavaScriptSemantics(permutationSource(10, isStatic));
    expect(ir.coverage).toMatchObject({
      status: "partial",
      omittedCount: null,
      resourceLimits: ["getter-expansion"],
    });
    expect(onlyBinding(ir, "result").value.status).toBe("unknown");
    expect(onlyBinding(ir, "result").provenance).toMatchObject({
      status: "local",
      origins: [],
    });
    expect(ir.limitations.join(" ")).toMatch(
      /Getter expansion was conservatively bounded/,
    );
    expectRetainedFacts(ir);
  },
);

it("keeps direct field writes through an escaped growing getter result", () => {
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { x: 1 };
    class Request {
      slot = shared;
      get grow() { return this.grow.more; }
    }
    new Request()[key].x = 2;
    const result = shared.x;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it("escapes constructed fields when a getter query widens its suffix", () => {
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { value: 1 };
    class Inner { alias = shared; }
    class Outer {
      get result() { return new Inner(); }
      get grow() { return this.grow.more; }
    }
    new Outer()[key].alias.value = 2;
    const result = shared.value;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it.each([
  {
    name: "600 instance getters",
    getters: 600,
    classes: 1,
    calls: 1,
    isStatic: false,
  },
  {
    name: "600 static getters",
    getters: 600,
    classes: 1,
    calls: 1,
    isStatic: true,
  },
  {
    name: "50-class hierarchy",
    getters: 20,
    classes: 50,
    calls: 1,
    isStatic: false,
  },
  {
    name: "300 calls with 50 getters",
    getters: 50,
    classes: 1,
    calls: 300,
    isStatic: false,
  },
] as const)(
  "keeps ordinary escapes complete with $name",
  ({ getters, classes, calls, isStatic }) => {
    const ir = analyzeJavaScriptSemantics(
      ordinaryConstructedEscapeSource(getters, classes, calls, isStatic),
    );
    expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
  },
);

it("preserves the existing ordinary constructed escape limitation", () => {
  const ir = analyzeJavaScriptSemantics(`
    const shared = { value: 1 };
    class Inner { alias = shared; }
    mutate(new Inner());
    const result = shared.value;
  `);
  expect(onlyBinding(ir, "result").value).toEqual({
    status: "literal",
    value: 1,
  });
  expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
});

it.each([
  [
    "static field",
    "class C { static slot = shared; static get loop() { return this.loop.more; } }",
    "C",
  ],
  [
    "inherited field",
    "class Base { slot = shared; get loop() { return this.loop.more; } } class C extends Base {}",
    "new C()",
  ],
  [
    "field also reached by an escaped getter result",
    "class C { slot = shared; get leaf() { return this.slot.x; } get loop() { return this.loop.more; } }",
    "new C()",
  ],
])(
  "preserves direct writes through %s during getter retry",
  (_name, setup, receiver) => {
    const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { x: 1 };
    ${setup}
    ${receiver}[key].x = 2;
    const result = shared.x;
    const unrelated = 42;
  `);
    expect(onlyBinding(ir, "result").value.status).toBe("unknown");
    expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
    expectRetainedFacts(ir);
  },
);

it("preserves direct field writes with 600 acyclic getters during retry", () => {
  const getters = Array.from(
    { length: 600 },
    (_, index) => `get field${index}() { return this._field${index}; }`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { x: 1 };
    class C { slot = shared; ${getters} }
    new C()[key].x = 2;
    const result = shared.x;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it.each([
  ["class constructor", "static alias = shared;", "return Inner;"],
  ["inline class", "", "return class { static alias = shared; };"],
  ["global constructed alias", "alias = shared;", "return external;"],
  [
    "constructed object member",
    "alias = shared;",
    "return container.external;",
  ],
  [
    "local constructed alias",
    "alias = shared;",
    "const constructed = new Inner(); return constructed;",
  ],
])("escapes fields of a widened %s getter result", (_name, fields, body) => {
  const ir = analyzeJavaScriptSemantics(`
      import imported from "dep";
      const shared = { value: 1 };
      class Inner { ${fields} }
      const external = new Inner();
      const container = { external };
      consume(external);
      class Outer {
        get result() { ${body} }
        get grow() { return this.grow.more; }
      }
      new Outer()[key].alias.value = 2;
      const result = shared.value;
      const unrelated = 42;
    `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it("escapes constructed getter results after the query state budget is exhausted", () => {
  const getters = Array.from(
    { length: 600 },
    (_, index) => `get field${index}() { return this._field${index}; }`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { value: 1 };
    class Inner { alias = shared; }
    class Outer { ${getters} get result() { return new Inner(); } }
    new Outer()[key].alias.value = 2;
    const result = shared.value;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it("follows nested constructed fields after widening a getter result", () => {
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { value: 1 };
    class Leaf { alias = shared; }
    class Inner { child = new Leaf(); }
    class Outer {
      get result() { return new Inner(); }
      get grow() { return this.grow.more; }
    }
    new Outer()[key].child.alias.value = 2;
    const result = shared.value;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
  expectRetainedFacts(ir);
});

it("keeps replacing a constructed field separate from mutating its former value", () => {
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { value: 1 };
    class Inner { alias = shared; }
    class Outer { get result() { return new Inner(); } }
    new Outer().result.alias = { value: 2 };
    const result = shared.value;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value).toEqual({
    status: "literal",
    value: 1,
  });
  expect(ir.coverage.status).toBe("complete");
  expectRetainedFacts(ir);
});

it("does not memoize ancestry-pruned results reached through an independent branch", () => {
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const one = { x: { y: 1 }, y: 1 };
    const two = { x: { y: 1 }, y: 1 };
    class C {
      get c() { return choose() ? this.a : this.d; }
      get a() { return choose() ? this.b.x : two; }
      get b() { return choose() ? this.a : one; }
      get d() { return this.e; }
      get e() { return this.b.x; }
    }
    new C().c.y = 5;
    const result = two.x.y;
    const unrelated = 42;
  `);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expectRetainedFacts(ir);
});

const plainGetterCoverageCases = [
  { count: 130, coverage: { status: "complete", omittedCount: 0 } },
  {
    count: 300,
    coverage: {
      status: "partial",
      omittedCount: null,
      resourceLimits: ["getter-expansion"],
    },
  },
] as const;

it.each(plainGetterCoverageCases)(
  "retains unrelated facts with $count plain class getters and $coverage.status coverage",
  ({ count, coverage }) => {
    const ir = analyzeJavaScriptSemantics(plainGetterSource(count));
    expectRetainedFacts(ir);
    expect(ir.coverage).toEqual(coverage);
  },
);

it.each(plainGetterCoverageCases)(
  "retains unrelated facts with $count plain object getters and $coverage.status coverage",
  ({ count, coverage }) => {
    const ir = analyzeJavaScriptSemantics(plainGetterSource(count, true));
    expectRetainedFacts(ir);
    expect(ir.coverage).toEqual(coverage);
  },
);

it.each(plainGetterCoverageCases)(
  "accounts for local result work with $count initialized getters and $coverage.status coverage",
  ({ count, coverage }) => {
    const ir = analyzeJavaScriptSemantics(
      plainGetterSource(count, false, true),
    );
    expectRetainedFacts(ir);
    expect(ir.coverage).toEqual(coverage);
  },
);

it("bounds a bundle of dynamic getter classes without discarding unrelated facts", () => {
  const ir = analyzeJavaScriptSemantics(bundledGetterSource());
  expectRetainedFacts(ir);
}, 1_000);

it.each([30])(
  "bounds permutations across %i unknown-key getters (#3839)",
  (count) => {
    const ir = analyzeJavaScriptSemantics(getterExpansionSource(count));
    expect(ir.coverage).toMatchObject({
      status: "partial",
      omittedCount: null,
      resourceLimits: ["getter-expansion"],
    });
    expect(onlyBinding(ir, "result").value).toMatchObject({
      status: "unknown",
    });
    expect(onlyBinding(ir, "result").provenance).toMatchObject({
      status: "local",
      origins: [],
    });
    expect(ir.references).toContainEqual(
      expect.objectContaining({
        name: "shared",
        resolution: "resolved",
        bindingId: onlyBinding(ir, "shared").bindingId,
      }),
    );
    expect(onlyCallable(ir, "field0").returnCoverage).toMatchObject({
      status: "complete",
      omittedCount: 0,
    });
    expect(ir.moduleLinks).toEqual([]);
    expect(ir.callSites.length).toBeGreaterThan(0);
    expect(ir.limitations.join(" ")).toMatch(
      /Getter expansion was conservatively bounded/,
    );
  },
);

it("escapes the selected deep getter result while preserving other objects and imports", () => {
  const getters = Array.from(
    { length: 600 },
    (_, index) => `get field${index}() { return this.field${index + 1}; }`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { x: 1 };
    const untouched = { x: 42 };
    class C { ${getters} get field600() { return shared; } }
    new C().field0.x = 2;
    const result = shared.x;
    const unrelated = untouched.x;
  `);
  expectRetainedFacts(ir);
  expect(onlyBinding(ir, "result").value.status).toBe("unknown");
  expect(onlyBinding(ir, "imported").provenance.status).toBe("module");
  expect(ir.coverage.resourceLimits).toEqual(["getter-expansion"]);
});

it("bounds inherited dynamic getters", () => {
  const source = getterExpansionSource().replace(
    "consume(new Request().field0)",
    "class Derived extends Request {} consume(new Derived().field0)",
  );
  expect(analyzeJavaScriptSemantics(source).coverage).toMatchObject({
    status: "partial",
    resourceLimits: ["getter-expansion"],
  });
});

it("limits deep acyclic getter chains before exhausting the native stack", () => {
  const getters = Array.from(
    { length: 600 },
    (_, index) => `get field${index}() { return this.field${index + 1}; }`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    class Request { ${getters} }
    consume(new Request().field0);
  `);
  expect(ir.coverage).toMatchObject({
    status: "partial",
    resourceLimits: ["getter-expansion"],
  });
});

it("starts a fresh budget for each independent property query", () => {
  const calls = "consume(new Box().value);\n".repeat(300);
  const ir = analyzeJavaScriptSemantics(`
    const shared = { x: 1 };
    class Box { state = shared; get value() { return this.state; } }
    ${calls}
    const unrelated = 42;
  `);
  expect(ir.coverage).toEqual({ status: "complete", omittedCount: 0 });
  expect(onlyBinding(ir, "unrelated").value).toEqual({
    status: "literal",
    value: 42,
  });
});

it.each(["class", "object"] as const)(
  "bounds branching local aliases inside one %s getter",
  (receiver) => {
    const aliases = Array.from(
      { length: 10 },
      (_, index) =>
        `const a${index + 1} = flag ? a${index}.left : a${index}.right;`,
    ).join("\n");
    const getter = `get state() { const a0 = this; ${aliases} return a10; }`;
    const definition =
      receiver === "class"
        ? `class Request { slot = shared; ${getter} } const request = new Request();`
        : `const request = { slot: shared, ${getter} };`;
    const ir = analyzeJavaScriptSemantics(`
    import imported from "dep";
    const shared = { value: 1 };
    ${definition}
    consume(request.state);
    const result = shared.value;
    const unrelated = 42;
  `);
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: ["getter-expansion"],
    });
    expect(onlyBinding(ir, "result").value.status).toBe("unknown");
    expectRetainedFacts(ir);
  },
);
